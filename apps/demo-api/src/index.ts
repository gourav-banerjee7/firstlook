/**
 * demo-api: a small bookings service worth monitoring, and worth breaking.
 */
import { SCENARIOS, type Scenario } from "@firstlook/shared";
import { initTelemetry, instrumentFastify, observeProcessMemory, tracedFetch } from "@firstlook/telemetry";
import Fastify from "fastify";
import { createDb, migrate } from "./db.js";
import { Faults } from "./faults.js";

const env = {
  port: Number(process.env.PORT ?? 8081),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://firstlook:firstlook@localhost:5432/demo",
  paymentsUrl: process.env.PAYMENTS_URL ?? "http://localhost:8082",
  otlp: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  adminToken: process.env.ADMIN_TOKEN ?? "dev-admin-token",
};

const tel = initTelemetry({ serviceName: "demo-api", serviceVersion: "1.4.0", otlpEndpoint: env.otlp });
const db = createDb(tel, env.databaseUrl);
const faults = new Faults(db, tel, env.paymentsUrl, env.adminToken);

const app = Fastify({ logger: false });
instrumentFastify(app, tel, () => faults.version);
observeProcessMemory(tel);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

app.get("/health", async () => ({ ok: true, version: faults.version }));

app.get<{ Querystring: { worker_id?: string; q?: string } }>("/bookings", async (req, reply) => {
  const workerId = Number(req.query.worker_id ?? Math.floor(Math.random() * 400));

  if (faults.isActive("noisy-blip") && Math.random() < 0.35) {
    tel.log("error", "upstream connection reset", { "error.type": "ECONNRESET", "http.route": "/bookings" });
    return reply.code(500).send({ error: "connection reset" });
  }

  if (faults.isActive("bad-deploy")) {
    // v1.4.1 searches booking notes with an unindexed, leading-wildcard ILIKE.
    const started = Date.now();
    const { rows } = await db.query(
      "SELECT bookings.search",
      `WITH unindexed_scan AS MATERIALIZED (SELECT pg_sleep(0.45 + random() * 0.6))
       SELECT id, worker_id, starts_at, status FROM bookings, unindexed_scan
       WHERE worker_id = $1 OR notes ILIKE $2
       ORDER BY starts_at DESC LIMIT 20`,
      [workerId, `%${req.query.q ?? "care"}%`],
    );
    const ms = Date.now() - started;
    if (ms > 500)
      tel.log("warn", "slow query", { "db.operation.name": "SELECT bookings.search", "db.duration_ms": ms });
    return { bookings: rows };
  }

  const { rows } = await db.query(
    "SELECT bookings.list",
    "SELECT id, worker_id, starts_at, status FROM bookings WHERE worker_id = $1 ORDER BY starts_at DESC LIMIT 20",
    [workerId],
  );
  return { bookings: rows };
});

app.post<{ Body: { workerId?: number; clientId?: number; amountCents?: number } }>("/bookings", async (req, reply) => {
  const body = req.body ?? {};
  const workerId = body.workerId ?? Math.floor(Math.random() * 400);
  const clientId = body.clientId ?? Math.floor(Math.random() * 2000);
  const amountCents = body.amountCents ?? 4500;

  const res = await tracedFetch(tel, "payments-stub", `${env.paymentsUrl}/charge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId, amountCents }),
    timeoutMs: 4000,
  }).catch((err: Error) => {
    tel.log("error", "payment charge failed", { "error.type": err.name, "server.address": "payments-stub" });
    return undefined;
  });
  if (!res || !res.ok) {
    if (res)
      tel.log("error", "payment charge failed", {
        "http.response.status_code": res.status,
        "server.address": "payments-stub",
      });
    return reply.code(502).send({ error: "payment failed" });
  }

  const { rows } = await db.query(
    "INSERT bookings",
    "INSERT INTO bookings (worker_id, client_id, starts_at, amount_cents) VALUES ($1, $2, now() + interval '3 days', $3) RETURNING id",
    [workerId, clientId, amountCents],
  );
  return reply.code(201).send({ id: rows[0]?.id });
});

/** The deploy log: what changed and when. Read by the agent's `recent_changes` tool. */
app.get<{ Querystring: { since?: string } }>("/deploys", async (req) => {
  const since = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 24 * 3600 * 1000);
  const { rows } = await db.query(
    "SELECT deploys.list",
    "SELECT service, version, commit, description, author, at FROM deploys WHERE at >= $1 ORDER BY at DESC LIMIT 50",
    [since],
  );
  return { deploys: rows };
});

// ---- Admin: the fault injector (token-protected; never visible to the agent) ---------------

app.addHook("onRequest", async (req, reply) => {
  if (req.url.startsWith("/admin") && req.headers["x-admin-token"] !== env.adminToken) {
    return reply.code(401).send({ error: "unauthorized" });
  }
});

app.get("/admin/scenarios", async () => ({ scenarios: faults.list(), version: faults.version }));

app.post<{ Params: { name: string; action: string } }>("/admin/scenarios/:name/:action", async (req, reply) => {
  const name = req.params.name as Scenario;
  if (!SCENARIOS.includes(name)) return reply.code(404).send({ error: "unknown scenario" });
  if (req.params.action === "start") await faults.start(name);
  else if (req.params.action === "stop") await faults.stop(name);
  else return reply.code(400).send({ error: "action must be start or stop" });
  return { scenarios: faults.list(), version: faults.version };
});

async function main() {
  for (let attempt = 1; ; attempt++) {
    try {
      await migrate(db);
      break;
    } catch (err) {
      if (attempt >= 30) throw err;
      await sleep(1000); // wait for Postgres
    }
  }
  await faults.load();
  setInterval(() => void faults.sweep().catch(() => undefined), 5000);
  await app.listen({ port: env.port, host: "0.0.0.0" });
  tel.log("info", "service started", { "service.version": faults.version, port: env.port });
}

const shutdown = async () => {
  await app.close();
  await tel.shutdown();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

main().catch((err) => {
  tel.log("error", "startup failed", { error: (err as Error).message });
  process.exit(1);
});
