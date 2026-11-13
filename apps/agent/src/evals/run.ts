/**
 * Run the evals: replay every recorded incident through each planner, grade the notes, and write
 * a results table. Exits non-zero when the deterministic playbook misses anything, so CI fails on
 * a change that breaks diagnosis.
 *
 *   pnpm --filter @firstlook/agent eval                 # playbook only (what CI runs)
 *   GEMINI_API_KEY=... EVAL_REPEATS=3 pnpm ... eval     # plus Gemini, 3 runs per case
 *   EVAL_OLLAMA=1 pnpm ... eval                         # plus a local Ollama model
 */
import { writeFileSync } from "node:fs";
import { config } from "../config.js";
import { investigate, type StepDraft } from "../investigator.js";
import { createTracer } from "../langfuse.js";
import { GeminiPlanner, OllamaPlanner } from "../planner/llm.js";
import { PlaybookPlanner } from "../planner/playbook.js";
import type { Planner } from "../planner/types.js";
import { replay } from "./cassette.js";
import { EXPECT, loadCases } from "./cases.js";
import { grade, type Grade } from "./graders.js";
import { DatasetSync } from "./langfuse-datasets.js";

interface Row {
  planner: string;
  case: string;
  run: number;
  pass: boolean;
  grades: Grade[];
  summary: string;
  toolCalls: number;
  tokens: number;
  ms: number;
}

const planners: Array<{ make: () => Planner; label: string; repeats: number }> = [
  { make: () => new PlaybookPlanner(), label: "playbook", repeats: 1 },
];
const repeats = Number(process.env.EVAL_REPEATS ?? 1);
if (process.env.GEMINI_API_KEY) {
  planners.push({
    make: () => new GeminiPlanner(config.gemini.apiKey, config.gemini.model),
    label: config.gemini.model,
    repeats,
  });
}
if (process.env.EVAL_OLLAMA) {
  planners.push({
    make: () => new OllamaPlanner(config.ollama.url, config.ollama.model),
    label: `ollama/${config.ollama.model}`,
    repeats,
  });
}

const cases = loadCases();
const tracer = createTracer(config.langfuse);
const datasets = tracer.enabled ? new DatasetSync(config.langfuse) : undefined;
const runName = `${process.env.EVAL_RUN_NAME ?? "local"}-${new Date().toISOString().slice(0, 16)}`;
await datasets?.ensure(cases);

const rows: Row[] = [];
for (const p of planners) {
  for (const c of cases) {
    for (let run = 1; run <= p.repeats; run++) {
      const steps: StepDraft[] = [];
      const trace = tracer.enabled
        ? tracer.start(
            "eval",
            { case: c.name, alert: c.alert },
            { tags: ["eval", p.label, c.name], metadata: { runName } },
          )
        : undefined;
      const started = Date.now();
      const r = await investigate({
        alert: c.alert,
        ...(c.runbook ? { runbook: c.runbook } : {}),
        planner: p.make(),
        ctx: {
          service: c.alert.service,
          onset: new Date(c.onset),
          grafanaUrl: "http://localhost:3000",
          sources: replay(c.cassette),
        },
        budgets: config.budgets,
        emit: async (s) => void steps.push(s),
        now: () => new Date(c.now),
        ...(trace ? { trace } : {}),
      });
      const grades = grade(
        {
          note: r.note,
          steps,
          toolCalls: r.toolCalls,
          maxSteps: config.budgets.maxSteps,
          ...(r.budgetHit ? { budgetHit: r.budgetHit } : {}),
        },
        EXPECT[c.scenario],
      );
      const pass = grades.every((g) => g.pass);
      rows.push({
        planner: p.label,
        case: c.name,
        run,
        pass,
        grades,
        summary: r.note.summary,
        toolCalls: r.toolCalls,
        tokens: r.tokens.input + r.tokens.output,
        ms: Date.now() - started,
      });
      if (trace) await datasets?.link(c.name, trace.traceId, runName, p.label, pass);
      const failed = grades.filter((g) => !g.pass);
      console.log(
        `${pass ? "✓" : "✗"} ${p.label.padEnd(18)} ${c.name.padEnd(18)} ${r.note.summary}${failed.length ? `\n    ${failed.map((g) => `${g.grader}: ${g.detail}`).join("\n    ")}` : ""}`,
      );
    }
  }
}

// ---- report ------------------------------------------------------------------------------------

const GR = ["cause", "noise", "links", "numbers", "budget"];
const lines = [
  `| Planner | Case | Pass | ${GR.join(" | ")} | Tool calls |`,
  `|---|---|---|${GR.map(() => "---").join("|")}|---|`,
];
const byKey = new Map<string, Row[]>();
for (const r of rows) byKey.set(`${r.planner}|${r.case}`, [...(byKey.get(`${r.planner}|${r.case}`) ?? []), r]);
for (const [key, rs] of byKey) {
  const [planner, name] = key.split("|");
  const rate = (f: (r: Row) => boolean) => `${rs.filter(f).length}/${rs.length}`;
  const cells = GR.map((g) => {
    const ok = rs.filter((r) => r.grades.find((x) => x.grader === g)?.pass).length;
    return ok === rs.length ? "✅" : `❌ ${ok}/${rs.length}`;
  });
  const calls = rs.reduce((a, r) => a + r.toolCalls, 0) / rs.length;
  lines.push(`| ${planner} | ${name} | ${rate((r) => r.pass)} | ${cells.join(" | ")} | ${calls.toFixed(1)} |`);
}
const total = rows.filter((r) => r.pass).length;
const table = lines.join("\n");
const report = `${table}\n\n${total}/${rows.length} runs passed · ${cases.length} recorded incidents · ${new Date().toISOString().slice(0, 10)}\n`;
writeFileSync(new URL("../../evals/results.md", import.meta.url), report);
writeFileSync(new URL("../../evals/results.json", import.meta.url), JSON.stringify(rows, null, 2) + "\n");
console.log(`\n${report}`);
if (process.env.GITHUB_STEP_SUMMARY)
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, `## Firstlook evals\n\n${report}`, { flag: "a" });

const playbookMisses = rows.filter((r) => r.planner === "playbook" && !r.pass);
if (playbookMisses.length) {
  console.error(`playbook missed ${playbookMisses.length} case(s): ${playbookMisses.map((r) => r.case).join(", ")}`);
  process.exit(1);
}
