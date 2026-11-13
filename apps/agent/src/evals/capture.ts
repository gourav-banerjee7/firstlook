/**
 * Capture eval cases from incidents on a running stack.
 *   pnpm --filter @firstlook/agent eval:capture <ids-file> [agent-url]
 * The ids file has lines of "<scenario> <incident-id>".
 */
import { readFileSync, writeFileSync } from "node:fs";
import { SCENARIOS, type Incident, type InvestigationStep, type Scenario } from "@firstlook/shared";
import { config } from "../config.js";
import { httpSources } from "../sources.js";
import { capture } from "./cassette.js";
import { CASES_DIR, type EvalCase } from "./cases.js";

const [idsFile, agent = "http://localhost:8080"] = process.argv.slice(2);
if (!idsFile) throw new Error("usage: capture <ids-file> [agent-url]");

for (const line of readFileSync(idsFile, "utf8").split("\n").filter(Boolean)) {
  const [scenario, id] = line.trim().split(/\s+/) as [Scenario, string];
  if (!SCENARIOS.includes(scenario)) throw new Error(`unknown scenario ${scenario}`);
  const res = await fetch(`${agent}/api/incidents/${id}`);
  if (!res.ok) throw new Error(`${id}: ${res.status}`);
  const { incident, steps } = (await res.json()) as {
    incident: Incident & { summary: string; runbookUrl?: string };
    steps: InvestigationStep[];
  };
  // "Now" is when the live investigation queried the backends.
  const started = steps.find((s) => s.title.startsWith("Investigation started"));
  const now = new Date(started?.at ?? incident.triagedAt ?? incident.startedAt);
  const cassette = await capture(httpSources(config.sources), {
    service: incident.service,
    onset: new Date(incident.startedAt),
    now,
    grafanaUrl: "http://localhost:3000",
  });
  const c: EvalCase = {
    name: scenario,
    scenario,
    alert: {
      alertName: incident.alertName,
      service: incident.service,
      severity: incident.severity ?? "warning",
      summary: incident.summary,
      startedAt: incident.startedAt,
    },
    ...(incident.runbookUrl ? { runbook: incident.runbookUrl } : {}),
    onset: incident.startedAt,
    now: now.toISOString(),
    capturedFrom: { incidentId: id, at: new Date().toISOString() },
    cassette,
  };
  writeFileSync(new URL(`${scenario}.json`, CASES_DIR), JSON.stringify(c) + "\n");
  console.log(
    `✓ ${scenario}: ${Object.keys(cassette.prom).length} metric queries, ${Object.values(cassette.logs).flat().length} log lines, ${Object.values(cassette.traces).flat().length} traces, ${cassette.deploys.length} deploys`,
  );
}
