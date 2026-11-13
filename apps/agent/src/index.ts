/**
 * Firstlook agent: receives Grafana alerts, groups them into incidents, investigates each one with
 * read-only tools, and serves the results to the Incident Room.
 */
import { SCENARIOS, type Scenario } from "@firstlook/shared";
import { initTelemetry } from "@firstlook/telemetry";
import Fastify, { type FastifyReply } from "fastify";
import { config } from "./config.js";
import { authenticate, parseAlerts } from "./ingest.js";
import { createTracer } from "./langfuse.js";
import { BreakItLimiter } from "./ratelimit.js";
import { httpSources } from "./sources.js";
import { Store } from "./store.js";
import { startWorker } from "./worker.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

const tel = initTelemetry({
  serviceName: "firstlook-agent",
  serviceVersion: "0.2.0",
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
});
const store = new Store(config.databaseUrl);
const tracer = createTracer(config.langfuse);
const investigateDelayMs = Number(process.env.INVESTIGATE_DELAY_MS ?? 60_000);

const app = Fastify({ logger: false, bodyLimit: 1_000_000, trustProxy: process.env.TRUST_PROXY === "true" });
const limiter = new BreakItLimiter(config.breakIt.cooldownSeconds * 1000, config.breakIt.perIpPerHour);

// Keep the raw body: HMAC signatures are computed over the exact bytes Grafana sent.
app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
  req.rawBody = body as Buffer;
  try {
    done(null, (body as Buffer).length ? JSON.parse((body as Buffer).toString("utf8")) : {});
  } catch (err) {
    (err as { statusCode?: number }).statusCode = 400;
    done(err as Error, undefined);
  }
});

app.addHook("onRequest", async (req, reply) => {
  reply.header("access-control-allow-origin", config.corsOrigin);
  reply.header("access-control-allow-headers", "content-type, x-admin-token");
  reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return reply.code(204).send();
});

app.get("/health", async () => ({
  ok: true,
  planner: config.provider,
  langfuse: tracer.enabled,
  breakIt: config.breakIt.enabled,
}));

// ---- ingest ----------------------------------------------------------------------------------

app.post("/webhooks/grafana", async (req, reply) => {
  const auth = authenticate(req.headers, req.rawBody ?? Buffer.alloc(0), {
    token: config.webhookToken,
    ...(process.env.WEBHOOK_HMAC_SECRET ? { hmacSecret: process.env.WEBHOOK_HMAC_SECRET } : {}),
  });
  if (!auth.ok) {
    tel.log("warn", "webhook rejected", { reason: auth.reason });
    return reply.code(401).send({ error: "unauthorized" });
  }
  let alerts;
  try {
    alerts = parseAlerts(req.body);
  } catch {
    return reply.code(400).send({ error: "not a Grafana alert payload" });
  }
  const outcomes = [];
  for (const a of alerts) {
    tel.log("info", "alert received", {
      status: a.status,
      alertname: a.alertName,
      service: a.service,
      severity: a.severity,
      startsAt: a.startsAt.toISOString(),
    });
    const outcome = await store.ingest(a, investigateDelayMs);
    tel.log("info", "alert ingested", {
      alertname: a.alertName,
      action: outcome.action,
      "incident.id": outcome.incidentId ?? "",
    });
    outcomes.push(outcome);
  }
  return reply.code(202).send({ accepted: outcomes.length, outcomes });
});

// ---- Incident Room API ---------------------------------------------------------------------

app.get<{ Querystring: { limit?: string } }>("/api/incidents", async (req) => ({
  incidents: await store.incidents(Math.min(200, Number(req.query.limit ?? 50) || 50)),
}));

app.get<{ Params: { id: string } }>("/api/incidents/:id", async (req, reply) => {
  const inc = await store.incident(req.params.id);
  if (!inc) return reply.code(404).send({ error: "not found" });
  return { incident: inc, steps: await store.steps(inc.id) };
});

/** Server-sent events: every step as it lands, plus incident status changes. */
app.get<{ Params: { id: string } }>("/api/incidents/:id/stream", async (req, reply: FastifyReply) => {
  const inc = await store.incident(req.params.id);
  if (!inc) return reply.code(404).send({ error: "not found" });
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "access-control-allow-origin": config.corsOrigin,
  });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  let lastSeq = 0;
  let lastState = "";
  let closed = false;
  const started = Date.now();
  req.raw.on("close", () => (closed = true));

  while (!closed && Date.now() - started < 10 * 60_000) {
    try {
      for (const s of await store.steps(inc.id, lastSeq)) {
        send("step", s);
        lastSeq = Number(s.id.split(":").pop());
      }
      const now = await store.incident(inc.id);
      const state = JSON.stringify([now?.status, now?.triagedAt, now?.resolvedAt, now?.flapping]);
      if (now && state !== lastState) {
        send("incident", now);
        lastState = state;
      }
      res.write(": ping\n\n");
    } catch {
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  res.end();
});

app.post<{ Params: { id: string } }>("/api/incidents/:id/reinvestigate", async (req, reply) => {
  if (req.headers["x-admin-token"] !== config.adminToken) return reply.code(401).send({ error: "unauthorized" });
  const inc = await store.incident(req.params.id);
  if (!inc) return reply.code(404).send({ error: "not found" });
  await store.enqueue("investigate", inc.id, `investigate:${inc.id}:${Date.now()}`);
  return reply.code(202).send({ queued: true });
});

app.post<{ Params: { id: string }; Body: { helpful?: unknown } }>("/api/incidents/:id/feedback", async (req, reply) => {
  if (typeof req.body?.helpful !== "boolean") return reply.code(400).send({ error: "helpful must be a boolean" });
  if (!(await store.saveFeedback(req.params.id, req.body.helpful)))
    return reply.code(404).send({ error: "no triaged incident with that id" });
  const inc = await store.incident(req.params.id);
  const traceId = inc?.investigation?.traceId;
  if (traceId) await tracer.score(traceId, "helpful", req.body.helpful ? 1 : 0, "Incident Room feedback");
  tel.log("info", "feedback received", { "incident.id": req.params.id, helpful: req.body.helpful });
  return reply.code(204).send();
});

/** "Break something": start a demo scenario, rate limited. The admin token never leaves the server. */
app.post<{ Params: { name: string } }>("/api/scenarios/:name", async (req, reply) => {
  if (!config.breakIt.enabled) return reply.code(403).send({ error: "Breaking things is turned off here" });
  const name = req.params.name as Scenario;
  if (!SCENARIOS.includes(name)) return reply.code(404).send({ error: "unknown scenario" });
  const verdict = limiter.check(req.ip);
  if (!verdict.ok) {
    reply.header("retry-after", String(verdict.retryAfterSeconds));
    return reply
      .code(429)
      .send({ error: `${verdict.reason}. Try again in ${Math.ceil(verdict.retryAfterSeconds / 60)} min.` });
  }
  const res = await fetch(new URL(`/admin/scenarios/${name}/start`, config.breakIt.demoApiUrl), {
    method: "POST",
    headers: { "x-admin-token": config.adminToken },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
  if (!res?.ok) return reply.code(502).send({ error: "The demo system didn't accept the fault" });
  limiter.record(req.ip);
  tel.log("info", "scenario started from incident room", { scenario: name });
  return reply.code(202).send({ message: "Fault injected. Grafana should alert within about a minute." });
});

// ---- start -----------------------------------------------------------------------------------

async function main() {
  for (let i = 0; ; i++) {
    try {
      await store.migrate();
      break;
    } catch (err) {
      if (i >= 20) throw err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  const stop = startWorker({ store, sources: httpSources(config.sources), tracer, cfg: config, tel });
  await app.listen({ port: config.port, host: "0.0.0.0" });
  tel.log("info", "firstlook agent listening", {
    port: config.port,
    planner: config.provider,
    langfuse: tracer.enabled,
  });

  const shutdown = async () => {
    stop();
    await app.close();
    await store.pool.end();
    await tel.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  tel.log("error", "startup failed", { error: (err as Error).message });
  process.exit(1);
});
