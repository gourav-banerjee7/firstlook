/**
 * Explicit OpenTelemetry setup for the demo services: traces, metrics and logs over OTLP/HTTP.
 *
 * Everything is wired by hand (no auto-instrumentation) so the signals the agent relies on are
 * predictable and documented: RED metrics per route, a dependency client histogram, DB timings,
 * process memory, and logs that carry the active trace id.
 */
import {
  context,
  metrics,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Histogram,
  type Meter,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { logs, SeverityNumber, type AnyValueMap, type Logger } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import type { FastifyInstance, FastifyRequest } from "fastify";

export type Level = "debug" | "info" | "warn" | "error";

export interface Telemetry {
  serviceName: string;
  tracer: Tracer;
  meter: Meter;
  log: (level: Level, msg: string, attrs?: Attributes) => void;
  /** Run fn inside a child span; the span records errors and ends when fn settles. */
  span: <T>(name: string, fn: (span: Span) => Promise<T>, attrs?: Attributes, kind?: SpanKind) => Promise<T>;
  shutdown: () => Promise<void>;
}

const SEVERITY: Record<Level, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

export interface TelemetryOptions {
  serviceName: string;
  serviceVersion: string;
  /** Base OTLP/HTTP endpoint, e.g. http://otel-collector:4318. Telemetry is local-only when unset. */
  otlpEndpoint?: string;
  /** How often metrics are pushed. Short by default so demos react quickly. */
  metricIntervalMs?: number;
}

export function initTelemetry(opts: TelemetryOptions): Telemetry {
  const resource = resourceFromAttributes({
    "service.name": opts.serviceName,
    "service.version": opts.serviceVersion,
    "deployment.environment.name": process.env.DEPLOY_ENV ?? "demo",
  });
  const endpoint = opts.otlpEndpoint?.replace(/\/$/, "");

  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  const tracerProvider = new TracerProvider({
    resource,
    spanProcessors: endpoint
      ? [new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }) })]
      : [],
  });
  trace.setGlobalTracerProvider(tracerProvider);

  const meterProvider = new MeterProvider({
    resource,
    readers: endpoint
      ? [
          new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
            exportIntervalMillis: opts.metricIntervalMs ?? 5000,
          }),
        ]
      : [],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  const loggerProvider = new LoggerProvider({
    resource,
    processors: endpoint
      ? [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: `${endpoint}/v1/logs` }) })]
      : [],
  });
  logs.setGlobalLoggerProvider(loggerProvider);
  const otelLogger: Logger = logs.getLogger(opts.serviceName);

  const tracer = trace.getTracer(opts.serviceName, opts.serviceVersion);
  const meter = metrics.getMeter(opts.serviceName, opts.serviceVersion);

  const log = (level: Level, msg: string, attrs: Attributes = {}) => {
    const spanCtx = trace.getActiveSpan()?.spanContext();
    // Structured stdout for humans and `docker logs`…
    process.stdout.write(
      JSON.stringify({
        time: new Date().toISOString(),
        level,
        service: opts.serviceName,
        msg,
        ...attrs,
        ...(spanCtx ? { trace_id: spanCtx.traceId, span_id: spanCtx.spanId } : {}),
      }) + "\n",
    );
    // …and the same record over OTLP to Loki, correlated with the active span.
    otelLogger.emit({
      severityNumber: SEVERITY[level],
      severityText: level.toUpperCase(),
      body: msg,
      attributes: attrs as AnyValueMap,
    });
  };

  const span: Telemetry["span"] = (name, fn, attrs, kind = SpanKind.INTERNAL) =>
    tracer.startActiveSpan(name, { attributes: attrs, kind }, async (s) => {
      try {
        return await fn(s);
      } catch (err) {
        s.recordException(err as Error);
        s.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        throw err;
      } finally {
        s.end();
      }
    });

  const shutdown = async () => {
    await Promise.allSettled([tracerProvider.shutdown(), meterProvider.shutdown(), loggerProvider.shutdown()]);
  };

  return { serviceName: opts.serviceName, tracer, meter, log, span, shutdown };
}

// ---- Fastify: a server span and RED metrics per request ------------------------------------

declare module "fastify" {
  interface FastifyRequest {
    otelSpan?: Span;
    otelStart?: bigint;
  }
}

/**
 * Wraps every request in a SERVER span (continuing an incoming W3C trace) and records
 * `http.server.request.duration` by route, method, status and the app's current version.
 */
export function instrumentFastify(app: FastifyInstance, tel: Telemetry, version: () => string) {
  const duration: Histogram = tel.meter.createHistogram("http.server.request.duration", {
    unit: "s",
    description: "Duration of HTTP server requests.",
    advice: { explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2.5, 5, 10] },
  });

  const route = (req: FastifyRequest) => req.routeOptions.url ?? "unmatched";

  app.addHook("onRequest", (req, _reply, done) => {
    const parent = propagation.extract(context.active(), req.headers);
    const s = tel.tracer.startSpan(
      `${req.method} ${route(req)}`,
      {
        kind: SpanKind.SERVER,
        attributes: { "http.request.method": req.method, "http.route": route(req), "url.path": req.url },
      },
      parent,
    );
    req.otelSpan = s;
    req.otelStart = process.hrtime.bigint();
    // Run the rest of the request lifecycle inside the span's context, so child spans and logs attach to it.
    context.with(trace.setSpan(parent, s), done);
  });

  app.addHook("onResponse", (req, reply, done) => {
    const status = reply.statusCode;
    const seconds = req.otelStart ? Number(process.hrtime.bigint() - req.otelStart) / 1e9 : 0;
    const attrs = {
      "http.request.method": req.method,
      "http.route": route(req),
      "http.response.status_code": status,
      version: version(),
    };
    if (route(req) !== "/health" && route(req) !== "/metrics") duration.record(seconds, attrs);
    if (req.otelSpan) {
      req.otelSpan.setAttribute("http.response.status_code", status);
      if (status >= 500) req.otelSpan.setStatus({ code: SpanStatusCode.ERROR });
      req.otelSpan.end();
    }
    done();
  });
}

// ---- Outgoing HTTP with trace propagation and a client histogram ---------------------------

const clientHistograms = new WeakMap<Meter, Histogram>();

/** fetch() with a CLIENT span, W3C trace headers, a timeout, and `http.client.request.duration`. */
export async function tracedFetch(
  tel: Telemetry,
  peer: string,
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  let hist = clientHistograms.get(tel.meter);
  if (!hist) {
    hist = tel.meter.createHistogram("http.client.request.duration", {
      unit: "s",
      description: "Duration of outgoing HTTP requests.",
      advice: { explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] },
    });
    clientHistograms.set(tel.meter, hist);
  }
  const method = (init.method ?? "GET").toUpperCase();
  const start = process.hrtime.bigint();
  return tel.span(
    `${method} ${peer}`,
    async (s) => {
      const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
      propagation.inject(context.active(), headers);
      let status = 0;
      try {
        const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(init.timeoutMs ?? 5000) });
        status = res.status;
        s.setAttribute("http.response.status_code", status);
        if (status >= 500) s.setStatus({ code: SpanStatusCode.ERROR });
        return res;
      } finally {
        hist.record(Number(process.hrtime.bigint() - start) / 1e9, {
          "server.address": peer,
          "http.request.method": method,
          "http.response.status_code": status, // 0 = timeout / connection error
        });
      }
    },
    { "server.address": peer, "http.request.method": method },
    SpanKind.CLIENT,
  );
}

/** Report process memory as `process.memory.usage` (resident set size). */
export function observeProcessMemory(tel: Telemetry) {
  tel.meter
    .createObservableGauge("process.memory.usage", { unit: "By", description: "Resident set size of the process." })
    .addCallback((r) => r.observe(process.memoryUsage().rss));
  tel.meter
    .createObservableGauge("process.uptime", { unit: "s", description: "Seconds since the process started." })
    .addCallback((r) => r.observe(process.uptime()));
}
