/**
 * Where a finished triage note goes besides the Incident Room:
 *  - a Grafana annotation on the service dashboard, so the note sits on the graph where it happened
 *  - a GitHub Issue, as the incident's durable record (opt-in: GITHUB_TOKEN + GITHUB_REPO)
 * Both are best-effort; a failed output never fails the investigation.
 */
import type { Incident, TriageNote } from "@firstlook/shared";

export interface OutputConfig {
  grafanaApiUrl?: string;
  grafanaAuth?: string; // "user:pass" or a service account token
  dashboardUid?: string;
  githubToken?: string;
  githubRepo?: string; // owner/name
  roomUrl?: string; // public Incident Room base, for links back
}

export function issueBody(inc: Incident, note: TriageNote, roomUrl?: string): string {
  const lines = [
    `> ${note.noise ? "**Judged as noise.** " : ""}${note.summary}`,
    "",
    `**Likely cause:** ${note.likelyCause}`,
    `**Confidence:** ${note.confidence}`,
    "",
    "### Evidence",
    ...(note.evidence.length
      ? note.evidence.map((e, i) => `${i + 1}. ${e.claim} ([query](${e.url}))`)
      : ["_No claim could be backed by a tool result._"]),
    "",
  ];
  if (note.ruledOut.length) lines.push("### Ruled out", ...note.ruledOut.map((r) => `- ${r}`), "");
  lines.push("### Next step", note.nextStep, "");
  if (note.runbook) lines.push(`Runbook: ${note.runbook}`, "");
  if (note.dropped?.length) {
    lines.push(
      "<details><summary>Removed by verification</summary>",
      "",
      ...note.dropped.map((d) => `- ~~${d.claim}~~ — ${d.reason}`),
      "",
      "</details>",
      "",
    );
  }
  lines.push("---", `Service \`${inc.service}\` · alert started ${inc.startedAt} · incident \`${inc.id}\``);
  if (roomUrl)
    lines.push(`[Open in the Incident Room](${roomUrl.replace(/\/$/, "")}/?incident=${encodeURIComponent(inc.id)})`);
  lines.push("", "_Written by Firstlook. Every claim above links to the query that backs it._");
  return lines.join("\n");
}

function authHeader(auth: string) {
  return auth.includes(":") ? `Basic ${Buffer.from(auth).toString("base64")}` : `Bearer ${auth}`;
}

export async function publish(
  inc: Incident,
  note: TriageNote,
  cfg: OutputConfig,
  log: (msg: string, attrs: Record<string, unknown>) => void,
) {
  const jobs: Promise<void>[] = [];

  if (cfg.grafanaApiUrl && cfg.grafanaAuth) {
    jobs.push(
      (async () => {
        const res = await fetch(new URL("/api/annotations", cfg.grafanaApiUrl), {
          method: "POST",
          signal: AbortSignal.timeout(10_000),
          headers: { "content-type": "application/json", authorization: authHeader(cfg.grafanaAuth!) },
          body: JSON.stringify({
            ...(cfg.dashboardUid ? { dashboardUID: cfg.dashboardUid } : {}),
            time: Date.parse(inc.startedAt),
            timeEnd: Date.now(),
            tags: ["firstlook", inc.service, note.noise ? "noise" : note.confidence],
            text: `<b>Firstlook:</b> ${note.summary}<br/>Likely cause: ${note.likelyCause}`,
          }),
        });
        if (!res.ok) throw new Error(`Grafana annotation failed (${res.status})`);
        log("grafana annotation added", { "incident.id": inc.id });
      })(),
    );
  }

  if (cfg.githubToken && cfg.githubRepo && /^[\w.-]+\/[\w.-]+$/.test(cfg.githubRepo)) {
    jobs.push(
      (async () => {
        const res = await fetch(`https://api.github.com/repos/${cfg.githubRepo}/issues`, {
          method: "POST",
          signal: AbortSignal.timeout(15_000),
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${cfg.githubToken}`,
            "x-github-api-version": "2022-11-28",
            "user-agent": "firstlook-agent",
          },
          body: JSON.stringify({
            title: `[${note.noise ? "noise" : (inc.severity ?? "incident")}] ${inc.alertName} on ${inc.service}`,
            body: issueBody(inc, note, cfg.roomUrl),
            labels: ["incident", inc.service, note.noise ? "noise" : `confidence:${note.confidence}`],
          }),
        });
        if (!res.ok) throw new Error(`GitHub issue failed (${res.status})`);
        const { html_url } = (await res.json()) as { html_url: string };
        log("github issue opened", { "incident.id": inc.id, url: html_url });
      })(),
    );
  }

  for (const r of await Promise.allSettled(jobs)) {
    if (r.status === "rejected") log("output failed", { "incident.id": inc.id, error: (r.reason as Error).message });
  }
}
