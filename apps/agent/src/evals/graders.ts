/**
 * Graders: each looks at one finished investigation and says pass or fail, with a reason.
 */
import type { TriageNote } from "@firstlook/shared";
import type { Expectation } from "./cases.js";
import type { StepDraft } from "../investigator.js";
import { numbersIn } from "../verify.js";

export interface Grade {
  grader: string;
  pass: boolean;
  detail: string;
}

export interface Graded {
  note: TriageNote;
  steps: StepDraft[];
  toolCalls: number;
  maxSteps: number;
  budgetHit?: string;
}

type Grader = (r: Graded, e: Expectation) => Grade;

const rightCause: Grader = (r, e) => {
  const text = `${r.note.summary} ${r.note.likelyCause}`;
  if (e.noise) return { grader: "cause", pass: true, detail: "n/a (noise case)" };
  if (e.cause && !e.cause.test(text))
    return { grader: "cause", pass: false, detail: `expected ${e.cause}, got "${r.note.likelyCause}"` };
  if (e.notCause && e.notCause.test(r.note.likelyCause))
    return { grader: "cause", pass: false, detail: `blamed a decoy: "${r.note.likelyCause}"` };
  return { grader: "cause", pass: true, detail: r.note.likelyCause };
};

const noiseVerdict: Grader = (r, e) => {
  const ok = r.note.noise === e.noise && !(e.noise && e.notCause?.test(r.note.likelyCause));
  return { grader: "noise", pass: ok, detail: `noise=${r.note.noise}, expected ${e.noise}` };
};

/** Every evidence link must be a Grafana Explore link reproducing the exact query of the step it cites. */
const validLinks: Grader = (r, e) => {
  if (!e.noise && r.note.evidence.length < 2)
    return { grader: "links", pass: false, detail: `${r.note.evidence.length} evidence item(s); need 2+` };
  const toolSteps = r.steps.filter((s) => s.kind === "tool");
  for (const ev of r.note.evidence) {
    const step = toolSteps.find((s) => (s.result as { step?: number } | undefined)?.step === ev.step);
    if (!step || step.url !== ev.url)
      return { grader: "links", pass: false, detail: `evidence for step ${ev.step} doesn't link to that step` };
    const url = new URL(ev.url);
    if (url.pathname.endsWith("/explore")) {
      const panes = JSON.parse(url.searchParams.get("panes") ?? "{}") as {
        a?: { queries?: Array<{ expr?: string; query?: string }> };
      };
      const q = panes.a?.queries?.[0];
      const linked = q?.expr ?? q?.query;
      if (!linked || !(step.query ?? "").startsWith(linked))
        return { grader: "links", pass: false, detail: `link for step ${ev.step} doesn't carry its query` };
    }
  }
  return { grader: "links", pass: true, detail: `${r.note.evidence.length} links, each reproducing its step` };
};

/** Independent of the verifier: re-check every number, and count what the verifier had to drop. */
const noInventedNumbers: Grader = (r) => {
  if (r.note.dropped?.length)
    return {
      grader: "numbers",
      pass: false,
      detail: `${r.note.dropped.length} claim(s) dropped: ${r.note.dropped[0]!.reason}`,
    };
  const toolSteps = r.steps.filter((s) => s.kind === "tool");
  for (const ev of r.note.evidence) {
    const step = toolSteps.find((s) => (s.result as { step?: number } | undefined)?.step === ev.step);
    const seen = new Set(
      numbersIn(
        `${step?.detail ?? ""} ${JSON.stringify((step?.result as { data?: unknown })?.data ?? "", (k, v) => (k.endsWith("_iso") ? undefined : v))}`,
      ),
    );
    const missing = numbersIn(ev.claim).filter((n) => !seen.has(n));
    if (missing.length)
      return {
        grader: "numbers",
        pass: false,
        detail: `"${ev.claim}" cites ${missing.join(", ")}, not in step ${ev.step}`,
      };
  }
  return { grader: "numbers", pass: true, detail: "every number traced to its step" };
};

const withinBudget: Grader = (r) => ({
  grader: "budget",
  pass: r.toolCalls <= r.maxSteps && !r.budgetHit,
  detail: r.budgetHit ? `hit: ${r.budgetHit}` : `${r.toolCalls}/${r.maxSteps} tool calls`,
});

export const GRADERS: Grader[] = [rightCause, noiseVerdict, validLinks, noInventedNumbers, withinBudget];

export function grade(r: Graded, e: Expectation): Grade[] {
  return GRADERS.map((g) => g(r, e));
}
