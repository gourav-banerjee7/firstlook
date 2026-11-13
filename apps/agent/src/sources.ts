/**
 * Read-only clients for the telemetry backends. The agent holds no write credentials for any
 * of them; the interface exists so tests and recorded replays can substitute canned data.
 */
export interface Series {
  labels: Record<string, string>;
  points: Array<[number, number]>; // [unix seconds, value]
}

export interface LogLine {
  at: number; // unix ms
  labels: Record<string, string>;
  line: string;
}

export interface TraceHit {
  traceId: string;
  rootName: string;
  rootService: string;
  durationMs: number;
  startMs: number;
}

export interface SpanInfo {
  name: string;
  service: string;
  durationMs: number;
  parent: boolean;
}

export interface Deploy {
  service: string;
  version: string;
  commit: string;
  description: string;
  author: string;
  at: string;
}

export interface Sources {
  promRange(expr: string, start: Date, end: Date, stepSeconds: number): Promise<Series[]>;
  logs(logql: string, start: Date, end: Date, limit: number): Promise<LogLine[]>;
  traces(traceql: string, start: Date, end: Date, limit: number): Promise<TraceHit[]>;
  traceSpans(traceId: string): Promise<SpanInfo[]>;
  deploys(since: Date): Promise<Deploy[]>;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}`);
  return (await res.json()) as T;
}

const secs = (d: Date) => Math.floor(d.getTime() / 1000);

export function httpSources(urls: { prometheus: string; loki: string; tempo: string; deploys: string }): Sources {
  return {
    async promRange(expr, start, end, step) {
      const u = new URL("/api/v1/query_range", urls.prometheus);
      u.search = new URLSearchParams({
        query: expr,
        start: String(secs(start)),
        end: String(secs(end)),
        step: String(step),
      }).toString();
      const body = await getJson<{
        data: { result: Array<{ metric: Record<string, string>; values: Array<[number, string]> }> };
      }>(u.href);
      return body.data.result.map((r) => ({
        labels: r.metric,
        points: r.values.map(([t, v]) => [t, Number(v)] as [number, number]).filter(([, v]) => Number.isFinite(v)),
      }));
    },

    async logs(logql, start, end, limit) {
      const u = new URL("/loki/api/v1/query_range", urls.loki);
      u.search = new URLSearchParams({
        query: logql,
        start: `${start.getTime()}000000`,
        end: `${end.getTime()}000000`,
        limit: String(limit),
        direction: "backward",
      }).toString();
      const body = await getJson<{
        data: { result: Array<{ stream: Record<string, string>; values: Array<[string, string]> }> };
      }>(u.href);
      return body.data.result
        .flatMap((s) => s.values.map(([ns, line]) => ({ at: Number(BigInt(ns) / 1_000_000n), labels: s.stream, line })))
        .sort((a, b) => b.at - a.at);
    },

    async traces(traceql, start, end, limit) {
      const u = new URL("/api/search", urls.tempo);
      u.search = new URLSearchParams({
        q: traceql,
        start: String(secs(start)),
        end: String(secs(end)),
        limit: String(limit),
      }).toString();
      const body = await getJson<{
        traces?: Array<{
          traceID: string;
          rootTraceName?: string;
          rootServiceName?: string;
          durationMs?: number;
          startTimeUnixNano: string;
        }>;
      }>(u.href);
      return (body.traces ?? []).map((t) => ({
        traceId: t.traceID,
        rootName: t.rootTraceName ?? "(unknown)",
        rootService: t.rootServiceName ?? "(unknown)",
        durationMs: t.durationMs ?? 0,
        startMs: Number(BigInt(t.startTimeUnixNano) / 1_000_000n),
      }));
    },

    async traceSpans(traceId) {
      const body = await getJson<{
        batches?: Array<{
          resource?: { attributes?: Array<{ key: string; value: { stringValue?: string } }> };
          scopeSpans?: Array<{
            spans?: Array<{ name: string; parentSpanId?: string; startTimeUnixNano: string; endTimeUnixNano: string }>;
          }>;
        }>;
      }>(new URL(`/api/traces/${encodeURIComponent(traceId)}`, urls.tempo).href);
      return (body.batches ?? []).flatMap((b) => {
        const service = b.resource?.attributes?.find((a) => a.key === "service.name")?.value.stringValue ?? "(unknown)";
        return (b.scopeSpans ?? []).flatMap((ss) =>
          (ss.spans ?? []).map((s) => ({
            name: s.name,
            service,
            durationMs: Number(BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano)) / 1e6,
            parent: !s.parentSpanId,
          })),
        );
      });
    },

    async deploys(since) {
      const u = new URL(urls.deploys);
      u.searchParams.set("since", since.toISOString());
      const body = await getJson<{ deploys: Deploy[] }>(u.href);
      return body.deploys;
    },
  };
}
