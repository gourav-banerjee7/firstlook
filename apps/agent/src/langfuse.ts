/**
 * Langfuse tracing over its public ingestion API: one trace per investigation, a span per tool
 * call, a generation per model call (with token usage). No SDK needed; a no-op when unconfigured.
 */
import { randomUUID } from "node:crypto";

interface Event {
  id: string;
  type: "trace-create" | "span-create" | "generation-create" | "score-create";
  timestamp: string;
  body: Record<string, unknown>;
}

export interface TraceHandle {
  readonly traceId: string;
  span(
    name: string,
    start: Date,
    end: Date,
    input: unknown,
    output: unknown,
    level?: "DEFAULT" | "WARNING" | "ERROR",
  ): void;
  generation(g: {
    name: string;
    model: string;
    start: Date;
    end: Date;
    input: unknown;
    output: unknown;
    usage: { input: number; output: number };
  }): void;
  end(output: unknown, metadata?: Record<string, unknown>): Promise<void>;
}

export interface Tracer {
  enabled: boolean;
  start(
    name: string,
    input: unknown,
    opts: { sessionId?: string; tags?: string[]; metadata?: Record<string, unknown> },
  ): TraceHandle;
  score(traceId: string, name: string, value: number, comment?: string): Promise<void>;
}

export function createTracer(cfg: { host: string; publicKey: string; secretKey: string }): Tracer {
  const enabled = Boolean(cfg.host && cfg.publicKey && cfg.secretKey);
  const auth = `Basic ${Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString("base64")}`;

  async function send(batch: Event[]) {
    if (!enabled || !batch.length) return;
    try {
      const res = await fetch(new URL("/api/public/ingestion", cfg.host), {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: { "content-type": "application/json", authorization: auth },
        body: JSON.stringify({ batch }),
      });
      if (!res.ok && res.status !== 207)
        console.warn(JSON.stringify({ msg: "langfuse ingestion failed", status: res.status }));
    } catch (err) {
      // Tracing must never break an investigation.
      console.warn(JSON.stringify({ msg: "langfuse unreachable", error: (err as Error).message }));
    }
  }

  const ev = (type: Event["type"], body: Record<string, unknown>): Event => ({
    id: randomUUID(),
    type,
    timestamp: new Date().toISOString(),
    body,
  });

  return {
    enabled,
    start(name, input, opts) {
      const traceId = randomUUID();
      const started = new Date();
      const events: Event[] = [];
      return {
        traceId,
        span(spanName, start, end, spanInput, output, level = "DEFAULT") {
          events.push(
            ev("span-create", {
              id: randomUUID(),
              traceId,
              name: spanName,
              startTime: start.toISOString(),
              endTime: end.toISOString(),
              input: spanInput,
              output,
              level,
            }),
          );
        },
        generation(g) {
          events.push(
            ev("generation-create", {
              id: randomUUID(),
              traceId,
              name: g.name,
              model: g.model,
              startTime: g.start.toISOString(),
              endTime: g.end.toISOString(),
              input: g.input,
              output: g.output,
              usage: { input: g.usage.input, output: g.usage.output, unit: "TOKENS" },
            }),
          );
        },
        async end(output, metadata) {
          await send([
            ev("trace-create", {
              id: traceId,
              name,
              timestamp: started.toISOString(),
              input,
              output,
              sessionId: opts.sessionId,
              tags: opts.tags,
              metadata: { ...opts.metadata, ...metadata },
            }),
            ...events,
          ]);
        },
      };
    },
    async score(traceId, name, value, comment) {
      await send([ev("score-create", { id: randomUUID(), traceId, name, value, comment })]);
    },
  };
}
