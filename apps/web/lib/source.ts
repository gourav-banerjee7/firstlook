/**
 * Where the Incident Room gets its data.
 *  - live:     a running Firstlook agent (NEXT_PUBLIC_AGENT_URL), steps streamed over SSE.
 *  - recorded: real investigations captured from the local stack, replayed at their original pace.
 *              Used on the public deployment, where there is no agent or Grafana to talk to.
 */
import type { Incident, InvestigationStep, Scenario } from "@firstlook/shared";
import recorded from "../data/recorded.json";

export type Mode = "live" | "recorded";

export interface Detail {
  incident: Incident;
  steps: InvestigationStep[];
}

export interface RecordedIncident extends Detail {
  scenario: Scenario;
}

export interface RecordedData {
  capturedAt: string;
  planner: string;
  incidents: RecordedIncident[];
}

export interface Watcher {
  onStep(step: InvestigationStep): void;
  onIncident(incident: Incident): void;
  onDone?(): void;
}

export interface Source {
  mode: Mode;
  list(): Promise<Incident[]>;
  detail(id: string): Promise<Detail | undefined>;
  /** Stream an incident: existing steps first, then new ones as they land. Returns a stop function. */
  watch(id: string, w: Watcher, opts?: { speed?: number }): () => void;
  breakIt?(scenario: Scenario): Promise<{ ok: boolean; message: string }>;
  feedback?(id: string, helpful: boolean): Promise<void>;
}

export const RECORDED = recorded as unknown as RecordedData;

export function liveSource(base: string): Source {
  const url = (p: string) => `${base.replace(/\/$/, "")}${p}`;
  return {
    mode: "live",
    async list() {
      const r = await fetch(url("/api/incidents?limit=50"), { cache: "no-store" });
      if (!r.ok) throw new Error(`agent returned ${r.status}`);
      return ((await r.json()) as { incidents: Incident[] }).incidents;
    },
    async detail(id) {
      const r = await fetch(url(`/api/incidents/${encodeURIComponent(id)}`), { cache: "no-store" });
      return r.ok ? ((await r.json()) as Detail) : undefined;
    },
    watch(id, w) {
      const es = new EventSource(url(`/api/incidents/${encodeURIComponent(id)}/stream`));
      es.addEventListener("step", (e) => w.onStep(JSON.parse((e as MessageEvent).data)));
      es.addEventListener("incident", (e) => w.onIncident(JSON.parse((e as MessageEvent).data)));
      return () => es.close();
    },
    async breakIt(scenario) {
      const r = await fetch(url(`/api/scenarios/${scenario}`), { method: "POST" });
      const body = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
      return { ok: r.ok, message: body.message ?? body.error ?? (r.ok ? "Started" : `Failed (${r.status})`) };
    },
    async feedback(id, helpful) {
      await fetch(url(`/api/incidents/${encodeURIComponent(id)}/feedback`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ helpful }),
      });
    },
  };
}

export function recordedSource(data: RecordedData = RECORDED): Source {
  return {
    mode: "recorded",
    async list() {
      return data.incidents.map((r) => r.incident);
    },
    async detail(id) {
      return data.incidents.find((r) => r.incident.id === id);
    },
    watch(id, w, opts) {
      const rec = data.incidents.find((r) => r.incident.id === id);
      if (!rec) return () => undefined;
      const speed = opts?.speed ?? 3;
      const { note: _note, triagedAt: _t, resolvedAt: _r, ...rest } = rec.incident;
      w.onIncident({ ...rest, status: "investigating" });
      const timers: ReturnType<typeof setTimeout>[] = [];
      let at = 0;
      let prev = rec.steps[0] ? Date.parse(rec.steps[0].at) : 0;
      rec.steps.forEach((s, i) => {
        // Original pacing, sped up, with each gap clamped so the replay neither stalls nor blurs.
        const gap = i === 0 ? 300 : Math.min(2600, Math.max(450, (Date.parse(s.at) - prev) / speed));
        prev = Date.parse(s.at);
        at += gap;
        timers.push(
          setTimeout(() => {
            w.onStep(s);
            if (s.kind === "note") {
              const { resolvedAt: _res, ...triaged } = rec.incident;
              w.onIncident({ ...triaged, status: "triaged" });
            }
          }, at),
        );
      });
      timers.push(
        setTimeout(() => {
          w.onIncident(rec.incident);
          w.onDone?.();
        }, at + 400),
      );
      return () => timers.forEach(clearTimeout);
    },
  };
}

export function createSource(): Source {
  const base = process.env.NEXT_PUBLIC_AGENT_URL;
  return base ? liveSource(base) : recordedSource();
}
