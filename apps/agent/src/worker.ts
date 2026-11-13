/**
 * Pulls investigation jobs off the queue and runs them. Safe to run several workers: jobs are
 * claimed with SKIP LOCKED, and a job whose worker dies is re-queued after five minutes.
 */
import type { Telemetry } from "@firstlook/telemetry";
import type { Config } from "./config.js";
import { investigate } from "./investigator.js";
import { publish } from "./outputs.js";
import type { Tracer } from "./langfuse.js";
import { createPlanner } from "./planner/index.js";
import { clean } from "./sanitize.js";
import type { Sources } from "./sources.js";
import type { Job, Store } from "./store.js";

export function startWorker(deps: {
  store: Store;
  sources: Sources;
  tracer: Tracer;
  cfg: Config;
  tel: Telemetry;
  concurrency?: number;
}) {
  const { store, sources, tracer, cfg, tel } = deps;
  let running = 0;
  let stopped = false;
  const max = deps.concurrency ?? 2;

  async function run(job: Job) {
    const inc = await store.incident(job.incident_id);
    if (!inc) return store.complete(job.id);
    const planner = createPlanner(cfg);
    await store.addStep(inc.id, {
      kind: "update",
      title: job.attempts > 1 ? `Investigation retry ${job.attempts} of 3` : "Investigation started",
      detail: `Planner: ${planner.name === "playbook" ? "built-in playbook (no LLM)" : `${planner.name}`}. Budget: ${cfg.budgets.maxSteps} tool calls, ${cfg.budgets.maxWallMs / 1000} s.`,
    });
    const trace = tracer.enabled
      ? tracer.start(
          "investigation",
          { alert: inc.alertName, service: inc.service, summary: inc.summary },
          {
            sessionId: inc.id,
            tags: [inc.service, inc.alertName, planner.name],
            metadata: { incidentId: inc.id },
          },
        )
      : undefined;

    const result = await tel.span(
      "investigate",
      () =>
        investigate({
          alert: {
            alertName: inc.alertName,
            service: inc.service,
            severity: inc.severity ?? "warning",
            summary: inc.summary,
            startedAt: inc.startedAt,
          },
          ...(inc.runbookUrl ? { runbook: inc.runbookUrl } : {}),
          planner,
          ctx: { service: inc.service, onset: new Date(inc.startedAt), grafanaUrl: cfg.grafanaUrl, sources },
          budgets: cfg.budgets,
          emit: (s) => store.addStep(inc.id, s),
          ...(trace ? { trace } : {}),
        }),
      { "incident.id": inc.id, "alert.name": inc.alertName },
    );
    await store.saveNote(inc.id, result.note, {
      planner: result.planner,
      toolCalls: result.toolCalls,
      tokens: result.tokens,
      wallMs: result.wallMs,
      ...(result.budgetHit ? { budgetHit: result.budgetHit } : {}),
      ...(trace ? { traceId: trace.traceId } : {}),
    });
    const saved = await store.incident(inc.id);
    if (saved)
      await publish(saved, result.note, cfg.outputs, (msg, attrs) =>
        tel.log("info", msg, attrs as Parameters<typeof tel.log>[2]),
      );
    await store.complete(job.id);
    tel.log("info", "incident triaged", {
      "incident.id": inc.id,
      confidence: result.note.confidence,
      noise: result.note.noise,
      evidence: result.note.evidence.length,
      dropped: result.note.dropped?.length ?? 0,
      tool_calls: result.toolCalls,
      wall_ms: result.wallMs,
    });
  }

  async function tick() {
    while (!stopped && running < max) {
      const job = await store.claim();
      if (!job) return;
      running++;
      void run(job)
        .catch(async (err) => {
          const msg = clean((err as Error).message, 300);
          const outcome = await store.fail(job, msg);
          tel.log("error", "investigation failed", { "incident.id": job.incident_id, error: msg, outcome });
          await store
            .addStep(job.incident_id, {
              kind: "update",
              title: outcome === "retry" ? "Investigation failed, will retry" : "Investigation failed",
              detail: msg,
            })
            .catch(() => undefined);
        })
        .finally(() => running--);
    }
  }

  const loop = setInterval(
    () => void tick().catch((e) => tel.log("error", "worker tick failed", { error: (e as Error).message })),
    1000,
  );
  const stale = setInterval(() => void store.requeueStale().catch(() => undefined), 60_000);
  return () => {
    stopped = true;
    clearInterval(loop);
    clearInterval(stale);
  };
}
