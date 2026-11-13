/**
 * Turning a Grafana webhook into ParsedAlerts, plus webhook authentication.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { clean } from "./sanitize.js";
import type { ParsedAlert } from "./store.js";

const GrafanaAlert = z.object({
  status: z.enum(["firing", "resolved"]),
  labels: z.record(z.string(), z.string()).default({}),
  annotations: z.record(z.string(), z.string()).default({}),
  startsAt: z.string(),
  fingerprint: z.string().optional(),
});

export const GrafanaWebhook = z.object({
  status: z.string().optional(),
  alerts: z.array(GrafanaAlert).max(100),
});

export function parseAlerts(body: unknown): ParsedAlert[] {
  const parsed = GrafanaWebhook.parse(body);
  return parsed.alerts
    .filter((a) => a.labels.alertname && (a.labels.service ?? a.labels.service_name))
    .map((a) => {
      const alertName = clean(a.labels.alertname, 120);
      const service = clean(a.labels.service ?? a.labels.service_name, 60);
      return {
        status: a.status,
        alertName,
        service,
        severity: clean(a.labels.severity ?? "warning", 20),
        summary: clean(a.annotations.summary ?? a.annotations.description ?? alertName, 300),
        ...(a.annotations.runbook_url?.startsWith("https://") ? { runbook: a.annotations.runbook_url } : {}),
        startsAt: new Date(a.startsAt),
        fingerprint: a.fingerprint ?? `${service}:${alertName}`,
      };
    });
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Bearer token (always), plus Grafana's HMAC signature when a secret is configured:
 * X-Grafana-Alerting-Signature = hex(HMAC-SHA256(secret, [timestamp + ":"] + body)).
 */
export function authenticate(
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer,
  opts: { token: string; hmacSecret?: string; maxSkewSeconds?: number },
): { ok: true } | { ok: false; reason: string } {
  const auth = String(headers.authorization ?? "");
  if (!safeEqual(auth, `Bearer ${opts.token}`)) return { ok: false, reason: "bad token" };
  if (!opts.hmacSecret) return { ok: true };
  const sig = String(headers["x-grafana-alerting-signature"] ?? "");
  const ts = headers["x-grafana-alerting-signature-timestamp"];
  const mac = createHmac("sha256", opts.hmacSecret);
  if (ts) {
    const skew = Math.abs(Date.now() / 1000 - Number(ts));
    if (!Number.isFinite(skew) || skew > (opts.maxSkewSeconds ?? 300)) return { ok: false, reason: "stale signature" };
    mac.update(`${String(ts)}:`);
  }
  mac.update(rawBody);
  return safeEqual(sig, mac.digest("hex")) ? { ok: true } : { ok: false, reason: "bad signature" };
}
