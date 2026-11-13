#!/usr/bin/env node
// Capture real investigations from a running agent into apps/web/data/recorded.json, which the
// public Incident Room replays. Input: lines of "<scenario> <incident-id>".
//   node scripts/record.mjs ids.txt [agent-url]
import { readFileSync, writeFileSync } from "node:fs";

const [idsFile, agent = "http://localhost:8080"] = process.argv.slice(2);
if (!idsFile) {
  console.error("usage: node scripts/record.mjs <ids-file> [agent-url]");
  process.exit(1);
}

const pairs = readFileSync(idsFile, "utf8")
  .split("\n")
  .map((l) => l.trim().split(/\s+/))
  .filter((p) => p.length === 2);

const incidents = [];
let planner = "playbook";
for (const [scenario, id] of pairs) {
  const res = await fetch(`${agent}/api/incidents/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`${id}: ${res.status}`);
  const { incident, steps } = await res.json();
  if (!incident.note) throw new Error(`${id} has no triage note yet`);
  planner = incident.investigation?.planner ?? planner;
  // Keep the investigation itself; drop anything after it that only makes sense live.
  incidents.push({ scenario, incident: { ...incident, scenario }, steps });
  console.log(`✓ ${scenario.padEnd(18)} ${id}  ${incident.note.summary}`);
}

const out = { capturedAt: new Date().toISOString(), planner, incidents };
writeFileSync(new URL("../apps/web/data/recorded.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${incidents.length} incidents to apps/web/data/recorded.json`);
