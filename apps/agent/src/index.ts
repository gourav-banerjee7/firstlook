/**
 * Firstlook agent (Phase 1 stub): receives Grafana alert webhooks and logs them, proving the
 * alert wiring end to end. Phase 2 replaces this with ingest, a queue and the investigator.
 */
import Fastify from "fastify";

const port = Number(process.env.PORT ?? 8080);
const token = process.env.WEBHOOK_TOKEN ?? "dev-webhook-token";

interface GrafanaAlert {
  status: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
}

const app = Fastify({ logger: false });

app.get("/health", async () => ({ ok: true }));

app.post<{ Body: { status?: string; alerts?: GrafanaAlert[] } }>("/webhooks/grafana", async (req, reply) => {
  if (req.headers.authorization !== `Bearer ${token}`) return reply.code(401).send({ error: "unauthorized" });
  for (const a of req.body?.alerts ?? []) {
    console.log(
      JSON.stringify({
        time: new Date().toISOString(),
        msg: "alert received",
        status: a.status,
        alertname: a.labels.alertname,
        service: a.labels.service,
        severity: a.labels.severity,
        summary: a.annotations.summary,
        startsAt: a.startsAt,
      }),
    );
  }
  return reply.code(202).send({ accepted: req.body?.alerts?.length ?? 0 });
});

app
  .listen({ port, host: "0.0.0.0" })
  .then(() => console.log(JSON.stringify({ msg: "firstlook agent (stub) listening", port })));
