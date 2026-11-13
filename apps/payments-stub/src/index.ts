/**
 * payments-stub: the downstream payment provider demo-api depends on.
 * During an outage it answers most charges slowly with 503s, like a struggling third party.
 */
import { initTelemetry, instrumentFastify } from "@firstlook/telemetry";
import Fastify from "fastify";

const env = {
  port: Number(process.env.PORT ?? 8082),
  otlp: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  adminToken: process.env.ADMIN_TOKEN ?? "dev-admin-token",
};

const tel = initTelemetry({ serviceName: "payments-stub", serviceVersion: "2.3.0", otlpEndpoint: env.otlp });
const app = Fastify({ logger: false });
instrumentFastify(app, tel, () => "2.3.0");

let outageUntil = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

app.get("/health", async () => ({ ok: true }));

app.post<{ Body: { clientId?: number; amountCents?: number } }>("/charge", async (req, reply) => {
  await sleep(20 + Math.random() * 40);
  if (Date.now() < outageUntil && Math.random() < 0.9) {
    await sleep(800 + Math.random() * 1700);
    tel.log("error", "processor unavailable", {
      "error.type": "UpstreamUnavailable",
      "payment.processor": "acquirer-b",
    });
    return reply.code(503).send({ error: "processor unavailable" });
  }
  return { id: `ch_${Math.random().toString(36).slice(2, 12)}`, amountCents: req.body?.amountCents ?? 0 };
});

app.post<{ Body: { on: boolean; seconds?: number } }>("/admin/outage", async (req, reply) => {
  if (req.headers["x-admin-token"] !== env.adminToken) return reply.code(401).send({ error: "unauthorized" });
  outageUntil = req.body.on ? Date.now() + (req.body.seconds ?? 240) * 1000 : 0;
  return { outageUntil };
});

app.listen({ port: env.port, host: "0.0.0.0" }).then(() => tel.log("info", "service started", { port: env.port }));

process.on("SIGTERM", async () => {
  await app.close();
  await tel.shutdown();
  process.exit(0);
});
