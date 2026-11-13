/**
 * Cassettes: the raw telemetry behind one real incident, captured once from the live backends and
 * replayed without them. Capture asks every question any tool can ask (every signal, every
 * breakdown, logs for every service, all traces over a low threshold, the deploy log), so a
 * planner that investigates differently from the one that ran live still gets real answers.
 *
 * Replay ignores the time arguments (the cassette already covers the incident window) except to
 * trim points, log lines and deploys to the range asked for.
 */
import type { Deploy, LogLine, Series, Sources, SpanInfo, TraceHit } from "../sources.js";
import { TOOLS, type ToolContext } from "../tools.js";

export interface Cassette {
  prom: Record<string, Series[]>;
  logs: Record<string, LogLine[]>;
  traces: Record<string, TraceHit[]>;
  spans: Record<string, SpanInfo[]>;
  deploys: Deploy[];
}

/** Trace queries differ only by their duration threshold; record once at the lowest one. */
const traceKey = (q: string) => q.replace(/duration > \d+ms/, "duration > *");
const thresholdMs = (q: string) => Number(/duration > (\d+)ms/.exec(q)?.[1] ?? 0);
const CAPTURE_MIN_MS = 50;

/** Wrap real sources, remembering every response. */
export function recording(real: Sources): { sources: Sources; cassette: Cassette } {
  const c: Cassette = { prom: {}, logs: {}, traces: {}, spans: {}, deploys: [] };
  const sources: Sources = {
    async promRange(expr, start, end, step) {
      return (c.prom[expr] = await real.promRange(expr, start, end, step));
    },
    async logs(q, start, end, limit) {
      return (c.logs[q] = await real.logs(q, start, end, limit));
    },
    async traces(q, start, end, limit) {
      const all = await real.traces(q.replace(/duration > \d+ms/, `duration > ${CAPTURE_MIN_MS}ms`), start, end, 1000);
      c.traces[traceKey(q)] = all;
      // Keep span breakdowns for the slowest few: those are the ones any threshold will look at.
      for (const t of [...all].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5)) {
        c.spans[t.traceId] ??= await real.traceSpans(t.traceId);
      }
      return all.filter((t) => t.durationMs > thresholdMs(q)).slice(0, limit);
    },
    async traceSpans(id) {
      return (c.spans[id] ??= await real.traceSpans(id));
    },
    async deploys(since) {
      const d = await real.deploys(since);
      for (const x of d) if (!c.deploys.some((y) => y.at === x.at && y.version === x.version)) c.deploys.push(x);
      return d;
    },
  };
  return { sources, cassette: c };
}

/** Every argument combination worth capturing, per tool. */
const VARIANTS: Record<string, Array<Record<string, unknown>>> = {
  metric_overview: ["latency_p99", "error_rate", "request_rate", "memory"].map((signal) => ({ signal })),
  metric_breakdown: ["latency_p99", "error_rate", "request_rate"].flatMap((signal) =>
    ["route", "status", "version", "method"].map((by) => ({ signal, by })),
  ),
  error_logs: [{}, { service: "payments-stub" }],
  slow_traces: [{ min_ms: CAPTURE_MIN_MS }],
  recent_changes: [{ lookback_minutes: 24 * 60 }],
  dependency_health: [{}],
};

export async function capture(real: Sources, ctx: Omit<ToolContext, "sources">): Promise<Cassette> {
  const { sources, cassette } = recording(real);
  for (const tool of TOOLS) {
    for (const args of VARIANTS[tool.name] ?? [{}]) {
      await tool.run({ ...ctx, sources }, tool.args.parse(args));
    }
  }
  // The deploy log is queried live today, so drop anything that hadn't happened yet at the time.
  cassette.deploys = cassette.deploys.filter((d) => new Date(d.at) <= ctx.now).sort((a, b) => b.at.localeCompare(a.at));
  return cassette;
}

class NotRecorded extends Error {}

export function replay(c: Cassette): Sources {
  const inRange = (t: number, start: Date, end: Date) => t >= start.getTime() && t <= end.getTime();
  return {
    async promRange(expr, start, end) {
      const s = c.prom[expr];
      if (!s) throw new NotRecorded("query not in the recording");
      return s.map((x) => ({ ...x, points: x.points.filter(([t]) => inRange(t * 1000, start, end)) }));
    },
    async logs(q, start, end, limit) {
      const l = c.logs[q];
      if (!l) throw new NotRecorded("log query not in the recording");
      return l.filter((x) => inRange(x.at, start, end)).slice(0, limit);
    },
    async traces(q, start, end, limit) {
      const t = c.traces[traceKey(q)];
      if (!t) throw new NotRecorded("trace query not in the recording");
      return t.filter((x) => x.durationMs > thresholdMs(q) && inRange(x.startMs, start, end)).slice(0, limit);
    },
    async traceSpans(id) {
      const s = c.spans[id];
      if (!s) throw new NotRecorded("trace not in the recording");
      return s;
    },
    async deploys(since) {
      return c.deploys.filter((d) => new Date(d.at) >= since);
    },
  };
}
