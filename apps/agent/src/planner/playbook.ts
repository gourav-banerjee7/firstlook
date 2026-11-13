/**
 * The playbook planner: a deterministic investigator that follows the same rules a senior
 * on-call engineer would, using the same tools and producing the same JSON actions as an LLM.
 *
 * It runs with no API key, it is the baseline the evals compare models against, and because its
 * notes go through the same verifier, it can't cite a number it didn't see either.
 */
import type { HistoryItem, Planner, PlannerInput, PlannerReply } from "./types.js";

type Kind = "latency" | "errors" | "memory";

export function kindOf(alertName: string): Kind {
  const n = alertName.toLowerCase();
  if (n.includes("memory")) return "memory";
  if (n.includes("latency") || n.includes("slow")) return "latency";
  return "errors";
}

const SEQUENCES: Record<Kind, Array<{ tool: string; args: Record<string, unknown>; reason: string }>> = {
  latency: [
    {
      tool: "metric_overview",
      args: { signal: "latency_p99" },
      reason: "See when latency left its baseline and how far.",
    },
    { tool: "recent_changes", args: {}, reason: "A deploy shortly before onset is the most common cause." },
    { tool: "slow_traces", args: { min_ms: 500 }, reason: "Find where the time in slow requests goes." },
    { tool: "metric_breakdown", args: { signal: "latency_p99", by: "route" }, reason: "Is it every route or one?" },
    { tool: "dependency_health", args: {}, reason: "Rule out a slow downstream service." },
  ],
  errors: [
    {
      tool: "metric_overview",
      args: { signal: "error_rate" },
      reason: "See the shape: sustained, or a short burst that recovered?",
    },
    { tool: "dependency_health", args: {}, reason: "Failing downstream calls often surface as our 5xx." },
    { tool: "recent_changes", args: {}, reason: "Check for a deploy just before onset." },
    { tool: "error_logs", args: {}, reason: "Read what the failing requests actually said." },
  ],
  memory: [
    { tool: "metric_overview", args: { signal: "memory" }, reason: "Is memory still climbing, or did it plateau?" },
    { tool: "recent_changes", args: {}, reason: "A steady climb that starts at a deploy points at that release." },
    { tool: "error_logs", args: {}, reason: "Look for GC or allocation warnings." },
  ],
};

const pct = (s: unknown) => (typeof s === "string" ? Number(s.replace("%", "")) : NaN);

function find(history: HistoryItem[], tool: string) {
  return history.find((h) => h.tool === tool && !h.error);
}

type Row = Record<string, unknown>;

export function conclude(input: PlannerInput) {
  const { history, alert } = input;
  const kind = kindOf(alert.alertName);
  const overview = find(history, "metric_overview");
  const ov = (overview?.data ?? {}) as Row;
  const changes = find(history, "recent_changes");
  const deploy = ((changes?.data as Row[] | undefined) ?? []).find((d) => {
    const m = Number(d.minutes_before_onset);
    // A change only explains a problem that starts soon after it.
    return m >= 0 && m <= 10;
  });
  const deps = find(history, "dependency_health");
  const badDep = ((deps?.data as Row[] | undefined) ?? []).find(
    (d) => pct(d.errors_now) > 20 || pct(d.errors_peak) > 20,
  );
  const traces = find(history, "slow_traces");
  const went = ((traces?.data as Row | undefined)?.time_went_to ?? null) as Row | null;
  const logs = find(history, "error_logs");
  const topLog = ((logs?.data as Row[] | undefined) ?? [])[0];
  const breakdown = find(history, "metric_breakdown");
  const topRoute = ((breakdown?.data as Row[] | undefined) ?? [])[0];

  const evidence: Array<{ claim: string; step: number }> = [];
  const ruled: string[] = [];
  const say = (h: HistoryItem | undefined, claim: string) => h && evidence.push({ claim, step: h.step });

  if (changes && !deploy) ruled.push(`No deploy of ${alert.service} in the 10 minutes before onset.`);
  if (deps && !badDep && kind !== "memory") ruled.push("Downstream dependencies look healthy.");

  // ---- failing dependency -------------------------------------------------------------------
  if (kind === "errors" && badDep) {
    say(overview, `${alert.service} 5xx error rate went from ${ov.baseline} to a peak of ${ov.peak}.`);
    say(deps, `Calls to ${badDep.dependency} are failing: errors ${badDep.errors_before} → ${badDep.errors_now}.`);
    if (topLog) say(logs, `Most common error: "${topLog.message}" (×${topLog.count_after_onset} since onset).`);
    return {
      summary: `${alert.service} is returning 5xx because ${badDep.dependency} is failing.`,
      likely_cause: `${badDep.dependency} is down or degraded; ${alert.service} passes its failures on to callers.`,
      confidence: "high" as const,
      evidence,
      ruled_out: ruled,
      next_step: `Check ${badDep.dependency}'s status page or owners. Consider failing fast or queueing bookings until it recovers.`,
      noise: false,
    };
  }

  // ---- short burst that is recovering on its own --------------------------------------------------
  if (
    kind === "errors" &&
    (ov.recovered === true || ov.falling === true) &&
    Number(ov.elevated_minutes) <= 3 &&
    !deploy &&
    !badDep
  ) {
    say(
      overview,
      `5xx error rate peaked at ${ov.peak}, was elevated for ${ov.elevated_minutes} min and ${ov.recovered ? "has recovered" : "is already falling"} (now ${ov.now}).`,
    );
    if (topLog) say(logs, `The errors were "${topLog.message}" (×${topLog.count_after_onset}).`);
    return {
      summary: `A ${ov.elevated_minutes}-minute burst of errors on ${alert.service} that is clearing up by itself.`,
      likely_cause: topLog
        ? `Transient "${topLog.message}" errors; nothing changed and no dependency is failing.`
        : "A transient blip; nothing changed.",
      confidence: "medium" as const,
      evidence,
      ruled_out: ruled,
      next_step:
        "No action needed now. If this recurs several times a day, investigate connection handling and tune the alert's duration.",
      noise: true,
    };
  }

  // ---- memory growth after a release ---------------------------------------------------------
  if (kind === "memory") {
    say(overview, `Process memory rose from ${ov.baseline} to ${ov.now}, rising at about ${ov.slope_per_min}/min.`);
    if (deploy) {
      say(
        changes,
        `Release ${deploy.version} "${deploy.description}" shipped ${deploy.minutes_before_onset} min before onset.`,
      );
      return {
        summary: `${alert.service} memory is climbing steadily since release ${deploy.version}; it will hit its limit and restart.`,
        likely_cause: `A memory leak introduced in ${deploy.version} ("${deploy.description}").`,
        confidence: "high" as const,
        evidence,
        ruled_out: ruled,
        next_step: `Roll back ${alert.service} from ${deploy.version} before the process is OOM-killed, then take a heap snapshot of the new code path.`,
        noise: false,
      };
    }
    return {
      summary: `${alert.service} memory is high and no release explains it.`,
      likely_cause: "Unclear: memory growth without a matching change. Could be load-driven caching or a slow leak.",
      confidence: "low" as const,
      evidence,
      ruled_out: ruled,
      next_step: "Take a heap snapshot and compare with request volume before restarting.",
      noise: false,
    };
  }

  // ---- bad deploy -----------------------------------------------------------------------------
  if (deploy) {
    say(
      overview,
      `${kind === "latency" ? "p99 latency" : "5xx error rate"} went from ${ov.baseline} to ${ov.now}, leaving baseline at ${ov.rose_at}.`,
    );
    say(
      changes,
      `Release ${deploy.version} "${deploy.description}" shipped ${deploy.minutes_before_onset} min before onset.`,
    );
    if (went) say(traces, `In the slowest request, ${went.share_percent}% of the time is spent in "${went.span}".`);
    if (topRoute && kind === "latency")
      say(breakdown, `Worst route: ${topRoute.route} at ${topRoute.now} (was ${topRoute.before}).`);
    return {
      summary: `${alert.service} ${kind === "latency" ? "slowed down" : "started failing"} right after release ${deploy.version}.`,
      likely_cause: went
        ? `Release ${deploy.version} ("${deploy.description}") made "${went.span}" slow.`
        : `Release ${deploy.version} ("${deploy.description}").`,
      confidence: went || kind === "errors" ? ("high" as const) : ("medium" as const),
      evidence,
      ruled_out: ruled,
      next_step: `Roll back ${alert.service} to the previous version.${went ? ` Then look at the query plan for "${went.span}".` : ""}`,
      noise: false,
    };
  }

  // ---- nothing conclusive -------------------------------------------------------------------
  say(overview, `${String(ov.now ?? "The signal")} now, against a baseline of ${String(ov.baseline ?? "unknown")}.`);
  if (went) say(traces, `Slow requests spend ${went.share_percent}% of their time in "${went.span}".`);
  if (topLog) say(logs, `Most common error: "${topLog.message}".`);
  return {
    summary: `${alert.alertName} on ${alert.service}; no deploy or failing dependency explains it yet.`,
    likely_cause: "Unclear from the available signals.",
    confidence: "low" as const,
    evidence,
    ruled_out: ruled,
    next_step: "Open the dashboard and check traffic volume and infrastructure (CPU, database) for the same window.",
    noise: false,
  };
}

export class PlaybookPlanner implements Planner {
  name = "playbook";

  async next(input: PlannerInput): Promise<PlannerReply> {
    const seq = SEQUENCES[kindOf(input.alert.alertName)];
    const done = new Set(input.history.map((h) => h.tool));
    const nextStep = seq.find((s) => !done.has(s.tool));
    const action =
      !input.mustFinish && nextStep ? { type: "call", ...nextStep } : { type: "finish", note: conclude(input) };
    return { action, usage: { input: 0, output: 0 }, model: "playbook" };
  }
}
