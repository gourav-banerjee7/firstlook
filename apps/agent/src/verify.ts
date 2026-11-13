/**
 * Evidence-or-drop. The model proposes claims, each citing a step. A claim survives only if:
 *   - the cited step exists and its tool call succeeded, and
 *   - every number in the claim appears in that step's result.
 * Links and queries are copied from the step, never from the model. If nothing survives, the
 * note can't be confident.
 */
import type { Confidence, DroppedClaim, Evidence, TriageNote } from "@firstlook/shared";
import type { DraftNote } from "./planner/types.js";

export interface VerifiableStep {
  step: number;
  tool: string;
  summary?: string;
  data?: unknown;
  error?: string;
  url?: string;
  query?: string;
}

const NUM = /\d+(?:[.,]\d+)*/g;

export function numbersIn(text: string): string[] {
  return text.match(NUM) ?? [];
}

function haystack(s: VerifiableStep): Set<string> {
  return new Set(numbersIn(`${s.summary ?? ""} ${JSON.stringify(s.data ?? "")}`));
}

const lower = (c: Confidence): Confidence => (c === "high" ? "medium" : "low");

export function verifyNote(
  draft: DraftNote,
  steps: VerifiableStep[],
  opts: { runbook?: string; author?: string } = {},
): TriageNote {
  const byStep = new Map(steps.map((s) => [s.step, s]));
  const evidence: Evidence[] = [];
  const dropped: DroppedClaim[] = [];

  for (const e of draft.evidence) {
    const s = byStep.get(e.step);
    if (!s) {
      dropped.push({ claim: e.claim, reason: `cites step ${e.step}, which doesn't exist` });
      continue;
    }
    if (s.error || !s.url) {
      dropped.push({ claim: e.claim, reason: `step ${e.step} has no result to cite` });
      continue;
    }
    const seen = haystack(s);
    const missing = numbersIn(e.claim).filter((n) => !seen.has(n));
    if (missing.length) {
      dropped.push({ claim: e.claim, reason: `${missing.join(", ")} not found in step ${e.step} (${s.tool})` });
      continue;
    }
    evidence.push({ claim: e.claim, url: s.url, query: s.query ?? "", step: s.step });
  }

  // Numbers in the headline must come from somewhere too.
  const all = new Set(steps.flatMap((s) => [...haystack(s)]));
  const headlineUnbacked = numbersIn(`${draft.summary} ${draft.likely_cause}`).filter((n) => !all.has(n));

  let confidence = draft.confidence;
  if (headlineUnbacked.length) {
    confidence = lower(confidence);
    dropped.push({
      claim: "(summary)",
      reason: `mentions ${headlineUnbacked.join(", ")}, which no tool returned; confidence lowered`,
    });
  }
  if (!draft.noise && evidence.length === 0) confidence = "low";
  else if (dropped.length > evidence.length) confidence = lower(confidence);

  return {
    summary: draft.summary,
    likelyCause: draft.likely_cause,
    confidence,
    evidence,
    ruledOut: draft.ruled_out,
    nextStep: draft.next_step,
    noise: draft.noise,
    ...(opts.runbook ? { runbook: opts.runbook } : {}),
    ...(dropped.length ? { dropped } : {}),
    ...(opts.author ? { author: opts.author } : {}),
  };
}
