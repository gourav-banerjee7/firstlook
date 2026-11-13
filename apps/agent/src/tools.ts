/**
 * The investigator's tools. All are read-only queries, and each returns:
 *   - summary: a short human sentence with the numbers that matter (what the model reads first)
 *   - data:    a small structured result (truncated, cleaned)
 *   - query + url: the exact query and a Grafana link that reproduces it
 *
 * Triage-note claims may only cite numbers that appear in a tool's summary or data; see verify.ts.
 */
import { z } from "zod";
import { exploreUrl, type Range } from "./links.js";
import { clean } from "./sanitize.js";
import type { Sources, Series } from "./sources.js";

export interface ToolContext {
  service: string;
  onset: Date;
  now: Date;
  grafanaUrl: string;
  sources: Sources;
}

export interface ToolOutput {
  summary: string;
  data: unknown;
  query: string;
  url: string;
}

export interface Tool<A extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  args: A;
  /** Human description of args, for the prompt. */
  argsHelp: string;
  run(ctx: ToolContext, args: z.infer<A>): Promise<ToolOutput>;
}

/** Infers arg types from the zod schema, so run() is typed without annotations. */
function defineTool<A extends z.ZodType>(t: Tool<A>): Tool<A> {
  return t;
}

// ---- formatting ------------------------------------------------------------------------------

type Unit = "seconds" | "ratio" | "rps" | "bytes";

export function fmt(v: number, unit: Unit): string {
  if (!Number.isFinite(v)) return "n/a";
  switch (unit) {
    case "seconds":
      return v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`;
    case "ratio":
      return `${(v * 100).toFixed(1)}%`;
    case "rps":
      return `${v.toFixed(1)} req/s`;
    case "bytes":
      return `${Math.round(v / 1_000_000)} MB`;
  }
}

export const hhmm = (d: Date | number) => new Date(d).toISOString().slice(11, 19) + " UTC";

// ---- series analysis -------------------------------------------------------------------------

export interface Shape {
  baseline: number;
  /** Peak of the elevated run behind this alert. */
  peak: number;
  current: number;
  /** When the elevated run behind this alert began, if there is one. */
  rose?: number;
  /** Length of that run, in minutes (to now if it's still going). */
  elevatedMinutes: number;
  /** Change per minute over the last ~3 minutes. */
  slopePerMin: number;
  recovered: boolean;
  /** Still elevated but well down from the peak (under 60% of it). */
  falling: boolean;
}

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

/**
 * Describe a series around an alert. The important part is finding the *run* of elevated points
 * that the alert belongs to (the one nearest onset), so that an earlier, unrelated incident in the
 * same window doesn't stretch the onset back or inflate how long this one has lasted.
 */
export function analyze(points: Array<[number, number]>, onset: Date, stepSeconds: number, unit: Unit): Shape {
  const onsetS = onset.getTime() / 1000;
  const vals = points.map(([, v]) => v);
  const before = points.filter(([t]) => t < onsetS - 180).map(([, v]) => v);
  const baseline =
    before.length >= 3 ? median(before) : median(vals.slice(0, Math.max(1, Math.floor(vals.length / 4))));
  const elevated = (v: number) =>
    unit === "ratio" ? v > baseline + 0.02 : v > baseline * 1.5 + (unit === "bytes" ? 5e6 : 0);

  // The elevated point closest to onset (within 5 min before to 2 min after), then grow the run both ways.
  let anchor = -1;
  let best = Infinity;
  points.forEach(([t, v], i) => {
    const d = Math.abs(t - onsetS);
    if (t >= onsetS - 300 && t <= onsetS + 120 && elevated(v) && d < best) {
      best = d;
      anchor = i;
    }
  });
  let rs = anchor;
  let re = anchor;
  if (anchor >= 0) {
    while (rs > 0 && elevated(points[rs - 1]![1])) rs--;
    while (re < points.length - 1 && elevated(points[re + 1]![1])) re++;
  }
  const run = anchor >= 0 ? vals.slice(rs, re + 1) : [];

  // "Now" is the last 30 s: responsive enough to see a blip clearing.
  const tail = vals.slice(-2);
  const current = tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : NaN;
  const last = points.slice(-12);
  const slopePerMin =
    last.length >= 2 ? ((last.at(-1)![1] - last[0]![1]) / Math.max(1, last.at(-1)![0] - last[0]![0])) * 60 : 0;
  const peak = run.length ? Math.max(...run) : vals.length ? Math.max(...vals) : NaN;
  const recovered = anchor >= 0 && !elevated(current);
  return {
    baseline,
    peak,
    current,
    ...(anchor >= 0 ? { rose: points[rs]![0] } : {}),
    elevatedMinutes: Math.round(((run.length * stepSeconds) / 60) * 10) / 10,
    slopePerMin,
    recovered,
    falling: anchor >= 0 && !recovered && current < peak * 0.6,
  };
}

// ---- queries ---------------------------------------------------------------------------------

const SIGNALS = ["latency_p99", "error_rate", "request_rate", "memory"] as const;
type Signal = (typeof SIGNALS)[number];

const BY = {
  route: "http_route",
  status: "http_response_status_code",
  version: "service_version",
  method: "http_request_method",
} as const;

const unitOf: Record<Signal, Unit> = {
  latency_p99: "seconds",
  error_rate: "ratio",
  request_rate: "rps",
  memory: "bytes",
};
const nameOf: Record<Signal, string> = {
  latency_p99: "p99 latency",
  error_rate: "5xx error rate",
  request_rate: "request rate",
  memory: "process memory",
};

function expr(signal: Signal, svc: string, by?: string): string {
  const sel = `service_name="${svc}"`;
  const g = by ? ` by (${by})` : "";
  switch (signal) {
    case "latency_p99":
      return `histogram_quantile(0.99, sum by (le${by ? `, ${by}` : ""}) (rate(http_server_request_duration_seconds_bucket{${sel}}[1m])))`;
    case "error_rate":
      return `(sum${g} (rate(http_server_request_duration_seconds_count{${sel},http_response_status_code=~"5.."}[1m])) or ${by ? `0 * sum${g} (rate(http_server_request_duration_seconds_count{${sel}}[1m]))` : "vector(0)"}) / sum${g} (rate(http_server_request_duration_seconds_count{${sel}}[1m]))`;
    case "request_rate":
      return `sum${g} (rate(http_server_request_duration_seconds_count{${sel}}[1m]))`;
    case "memory":
      return `max${g} (process_memory_usage_bytes{${sel}})`;
  }
}

function windowFor(ctx: ToolContext, minutesBefore: number): Range {
  return { from: new Date(ctx.onset.getTime() - minutesBefore * 60_000), to: ctx.now };
}

const STEP = 15;

// ---- tools -----------------------------------------------------------------------------------

const metricOverview = defineTool({
  name: "metric_overview",
  description:
    "Shape of one service signal around the alert: baseline before onset, peak, current value, when it rose, trend.",
  args: z.object({ signal: z.enum(SIGNALS) }),
  argsHelp: `{"signal": one of ${SIGNALS.join(" | ")}}`,
  async run(ctx, { signal }) {
    const range = windowFor(ctx, 20);
    const q = expr(signal, ctx.service);
    const [series] = await ctx.sources.promRange(q, range.from, range.to, STEP);
    const unit = unitOf[signal];
    const url = exploreUrl(ctx.grafanaUrl, "prometheus", q, range);
    if (!series || series.points.length === 0) {
      return {
        summary: `No ${nameOf[signal]} data for ${ctx.service} in this window.`,
        data: { signal, points: 0 },
        query: q,
        url,
      };
    }
    const s = analyze(series.points, ctx.onset, STEP, unit);
    const parts = [
      `${nameOf[signal]} for ${ctx.service}: baseline ${fmt(s.baseline, unit)}, peak ${fmt(s.peak, unit)}, now ${fmt(s.current, unit)}`,
    ];
    if (unit !== "ratio" && s.baseline > 0) parts[0] += ` (${(s.current / s.baseline).toFixed(1)}x baseline)`;
    parts[0] += ".";
    parts.push(
      s.rose !== undefined
        ? `Left baseline at ${hhmm(s.rose * 1000)}; elevated for ${s.elevatedMinutes} min${s.recovered ? ", and has since recovered" : s.falling ? `, falling (now under 60% of the peak)` : ", still elevated"}.`
        : "No clear departure from baseline in this window.",
    );
    if (signal === "memory") {
      parts.push(
        s.slopePerMin > 1_000_000 ? `Rising steadily at about ${fmt(s.slopePerMin, "bytes")}/min.` : "Not rising.",
      );
    }
    return {
      summary: parts.join(" "),
      data: {
        signal,
        baseline: fmt(s.baseline, unit),
        peak: fmt(s.peak, unit),
        now: fmt(s.current, unit),
        rose_at: s.rose ? hhmm(s.rose * 1000) : null,
        rose_at_iso: s.rose ? new Date(s.rose * 1000).toISOString() : null,
        elevated_minutes: s.elevatedMinutes,
        recovered: s.recovered,
        falling: s.falling,
        ...(signal === "memory" ? { slope_per_min: fmt(s.slopePerMin, "bytes") } : {}),
      },
      query: q,
      url,
    };
  },
});

const metricBreakdown = defineTool({
  name: "metric_breakdown",
  description:
    "Split a signal by route, status, version or method, comparing before onset with now. Shows where the problem is concentrated.",
  args: z.object({
    signal: z.enum(["latency_p99", "error_rate", "request_rate"]),
    by: z.enum(["route", "status", "version", "method"]),
  }),
  argsHelp: `{"signal": "latency_p99" | "error_rate" | "request_rate", "by": "route" | "status" | "version" | "method"}`,
  async run(ctx, { signal, by }) {
    const range = windowFor(ctx, 15);
    const label = BY[by];
    const q = expr(signal, ctx.service, label);
    const series: Series[] = await ctx.sources.promRange(q, range.from, range.to, STEP);
    const unit = unitOf[signal];
    const rows = series
      .map((s) => {
        const sh = analyze(s.points, ctx.onset, STEP, unit);
        return { [by]: clean(s.labels[label] ?? "(none)", 60), before: sh.baseline, now: sh.current };
      })
      .filter((r) => Number.isFinite(r.now) || Number.isFinite(r.before))
      .sort((a, b) => (Number(b.now) || 0) - (Number(a.now) || 0))
      .slice(0, 8);
    const pretty = rows.map((r) => ({
      [by]: r[by],
      before: fmt(Number(r.before), unit),
      now: fmt(Number(r.now), unit),
    }));
    const summary = pretty.length
      ? `${nameOf[signal]} by ${by}: ` + pretty.map((r) => `${r[by]} ${r.before} → ${r.now}`).join("; ") + "."
      : `No ${nameOf[signal]} data by ${by}.`;
    return { summary, data: pretty, query: q, url: exploreUrl(ctx.grafanaUrl, "prometheus", q, range) };
  },
});

const errorLogs = defineTool({
  name: "error_logs",
  description:
    "Warning and error logs around the onset, grouped by message, with counts before vs after onset and sample attributes.",
  args: z.object({
    service: z
      .string()
      .regex(/^[a-z0-9-]{1,40}$/)
      .optional(),
  }),
  argsHelp: `{"service"?: service name, defaults to the alerting service}`,
  async run(ctx, { service }) {
    const svc = service ?? ctx.service;
    const range = windowFor(ctx, 10);
    const q = `{service_name="${svc}"} | severity_text=~"ERROR|WARN"`;
    const lines = await ctx.sources.logs(q, range.from, range.to, 1000);
    const onsetMs = ctx.onset.getTime() - 60_000;
    const SKIP = new Set([
      "service_name",
      "service_version",
      "deployment_environment_name",
      "detected_level",
      "observed_timestamp",
      "scope_name",
      "severity_number",
      "flags",
      "trace_id",
      "span_id",
      "severity_text",
    ]);
    const groups = new Map<
      string,
      {
        message: string;
        level: string;
        before: number;
        after: number;
        first: number;
        last: number;
        attrs: Record<string, string>;
        versions: Set<string>;
      }
    >();
    for (const l of lines) {
      const message = clean(l.line, 120);
      const g = groups.get(message) ?? {
        message,
        level: (l.labels.severity_text ?? "").toLowerCase(),
        before: 0,
        after: 0,
        first: l.at,
        last: l.at,
        attrs: {},
        versions: new Set<string>(),
      };
      if (l.at < onsetMs) g.before++;
      else g.after++;
      g.first = Math.min(g.first, l.at);
      g.last = Math.max(g.last, l.at);
      if (l.labels.service_version) g.versions.add(clean(l.labels.service_version, 20));
      for (const [k, v] of Object.entries(l.labels))
        if (!SKIP.has(k) && Object.keys(g.attrs).length < 5) g.attrs[clean(k, 40)] = clean(v, 80);
      groups.set(message, g);
    }
    const top = [...groups.values()].sort((a, b) => b.after - a.after).slice(0, 6);
    const data = top.map((g) => ({
      message: g.message,
      level: g.level,
      count_before_onset: g.before,
      count_after_onset: g.after,
      first_seen: hhmm(g.first),
      versions: [...g.versions],
      sample_attributes: g.attrs,
    }));
    const summary = top.length
      ? `${lines.length} warning/error logs from ${svc} since ${hhmm(range.from)}. ` +
        data
          .slice(0, 3)
          .map(
            (g) =>
              `"${g.message}" (${g.level}) ×${g.count_after_onset} after onset vs ×${g.count_before_onset} before, first seen ${g.first_seen}`,
          )
          .join("; ") +
        "."
      : `No warning or error logs from ${svc} since ${hhmm(range.from)}.`;
    return { summary, data, query: q, url: exploreUrl(ctx.grafanaUrl, "loki", q, range) };
  },
});

const slowTraces = defineTool({
  name: "slow_traces",
  description: "The slowest server requests since onset and, for the slowest one, which span the time went to.",
  args: z.object({ min_ms: z.number().int().min(50).max(30_000).default(500) }),
  argsHelp: `{"min_ms"?: integer threshold in ms, default 500}`,
  async run(ctx, { min_ms }) {
    const range = windowFor(ctx, 3);
    const q = `{resource.service.name="${ctx.service}" && kind=server && duration > ${min_ms}ms}`;
    const hits = await ctx.sources.traces(q, range.from, range.to, 20);
    const url = exploreUrl(ctx.grafanaUrl, "tempo", q, range);
    if (!hits.length)
      return {
        summary: `No ${ctx.service} requests slower than ${min_ms} ms since ${hhmm(range.from)}.`,
        data: { count: 0 },
        query: q,
        url,
      };
    const sorted = [...hits].sort((a, b) => b.durationMs - a.durationMs);
    const slowest = sorted[0]!;
    const byRoute = new Map<string, number>();
    for (const h of hits) byRoute.set(clean(h.rootName, 80), (byRoute.get(clean(h.rootName, 80)) ?? 0) + 1);
    let where = "";
    let breakdown: unknown = null;
    try {
      const spans = await ctx.sources.traceSpans(slowest.traceId);
      const child = spans.filter((s) => !s.parent).sort((a, b) => b.durationMs - a.durationMs)[0];
      if (child && slowest.durationMs > 0) {
        const share = Math.round((child.durationMs / slowest.durationMs) * 100);
        where = ` ${share}% of it in "${clean(child.name, 80)}" (${fmt(child.durationMs / 1000, "seconds")}, ${clean(child.service, 40)}).`;
        breakdown = {
          span: clean(child.name, 80),
          service: clean(child.service, 40),
          duration: fmt(child.durationMs / 1000, "seconds"),
          share_percent: share,
        };
      }
    } catch {
      where = " (span breakdown unavailable)";
    }
    return {
      summary:
        `${hits.length}${hits.length === 20 ? "+" : ""} ${ctx.service} requests over ${min_ms} ms since ${hhmm(range.from)}, ` +
        `mostly ${[...byRoute.entries()].sort((a, b) => b[1] - a[1])[0]![0]}. Slowest: ${clean(slowest.rootName, 80)} at ${fmt(slowest.durationMs / 1000, "seconds")}.` +
        where,
      data: {
        count: hits.length,
        by_route: Object.fromEntries(byRoute),
        slowest: {
          trace_id: slowest.traceId,
          name: clean(slowest.rootName, 80),
          duration: fmt(slowest.durationMs / 1000, "seconds"),
        },
        time_went_to: breakdown,
      },
      query: q,
      url,
    };
  },
});

const recentChanges = defineTool({
  name: "recent_changes",
  description: "Deploys of the service in the window before the alert, with how long before onset each landed.",
  args: z.object({
    lookback_minutes: z
      .number()
      .int()
      .min(5)
      .max(24 * 60)
      .default(60),
  }),
  argsHelp: `{"lookback_minutes"?: integer, default 60}`,
  async run(ctx, { lookback_minutes }) {
    const since = new Date(ctx.onset.getTime() - lookback_minutes * 60_000);
    const deploys = (await ctx.sources.deploys(since)).filter((d) => d.service === ctx.service);
    const rows = deploys.slice(0, 5).map((d) => {
      const before = Math.round((ctx.onset.getTime() - new Date(d.at).getTime()) / 60_000);
      return {
        version: clean(d.version, 20),
        commit: clean(d.commit, 12),
        description: clean(d.description, 100),
        author: clean(d.author, 40),
        at: hhmm(new Date(d.at)),
        at_iso: new Date(d.at).toISOString(),
        minutes_before_onset: before,
      };
    });
    const q = `SELECT version, commit, description, at FROM deploys WHERE service = '${ctx.service}' AND at >= '${since.toISOString()}'`;
    const url = `${ctx.grafanaUrl.replace(/\/$/, "")}/d/demo-api?from=${since.getTime()}&to=${ctx.now.getTime()}`;
    const summary = rows.length
      ? `${rows.length} deploy(s) of ${ctx.service} in the ${lookback_minutes} min before onset: ` +
        rows
          .map(
            (r) =>
              `${r.version} "${r.description}" at ${r.at}, ${r.minutes_before_onset >= 0 ? `${r.minutes_before_onset} min before onset` : `${-r.minutes_before_onset} min after onset`}`,
          )
          .join("; ") +
        "."
      : `No deploys of ${ctx.service} in the ${lookback_minutes} min before onset.`;
    return { summary, data: rows, query: q, url };
  },
});

const dependencyHealth = defineTool({
  name: "dependency_health",
  description: "Error rate and p99 latency of every downstream call the service makes, before onset vs now.",
  args: z.object({}),
  argsHelp: "{}",
  async run(ctx) {
    const range = windowFor(ctx, 15);
    const sel = `service_name="${ctx.service}"`;
    const errQ = `(sum by (server_address) (rate(http_client_request_duration_seconds_count{${sel},http_response_status_code=~"5..|0"}[1m])) or 0 * sum by (server_address) (rate(http_client_request_duration_seconds_count{${sel}}[1m]))) / sum by (server_address) (rate(http_client_request_duration_seconds_count{${sel}}[1m]))`;
    const latQ = `histogram_quantile(0.99, sum by (le, server_address) (rate(http_client_request_duration_seconds_bucket{${sel}}[1m])))`;
    const [errs, lats] = await Promise.all([
      ctx.sources.promRange(errQ, range.from, range.to, STEP),
      ctx.sources.promRange(latQ, range.from, range.to, STEP),
    ]);
    const deps = new Map<string, Record<string, string>>();
    for (const s of errs) {
      const sh = analyze(s.points, ctx.onset, STEP, "ratio");
      const name = clean(s.labels.server_address ?? "(unknown)", 60);
      deps.set(name, {
        dependency: name,
        errors_before: fmt(sh.baseline, "ratio"),
        errors_now: fmt(sh.current, "ratio"),
        errors_peak: fmt(sh.peak, "ratio"),
      });
    }
    for (const s of lats) {
      const sh = analyze(s.points, ctx.onset, STEP, "seconds");
      const name = clean(s.labels.server_address ?? "(unknown)", 60);
      Object.assign(deps.get(name) ?? deps.set(name, { dependency: name }).get(name)!, {
        p99_before: fmt(sh.baseline, "seconds"),
        p99_now: fmt(sh.current, "seconds"),
      });
    }
    const rows = [...deps.values()];
    const summary = rows.length
      ? `Downstream calls from ${ctx.service}: ` +
        rows
          .map(
            (r) =>
              `${r.dependency} errors ${r.errors_before ?? "n/a"} → ${r.errors_now ?? "n/a"} (peak ${r.errors_peak ?? "n/a"}), p99 ${r.p99_before ?? "n/a"} → ${r.p99_now ?? "n/a"}`,
          )
          .join("; ") +
        "."
      : `${ctx.service} made no downstream calls in this window.`;
    return {
      summary,
      data: rows,
      query: `${errQ}\n\n${latQ}`,
      url: exploreUrl(ctx.grafanaUrl, "prometheus", errQ, range),
    };
  },
});

export const TOOLS = [
  metricOverview,
  metricBreakdown,
  errorLogs,
  slowTraces,
  recentChanges,
  dependencyHealth,
] as unknown as Tool[];

export const toolByName = (name: string) => TOOLS.find((t) => t.name === name);
