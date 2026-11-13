/**
 * Domain types shared by the agent, the demo system and the Incident Room.
 */

/** The four failure scenarios the demo system can produce. */
export const SCENARIOS = ["bad-deploy", "dependency-outage", "memory-leak", "noisy-blip"] as const;
export type Scenario = (typeof SCENARIOS)[number];

export const SCENARIO_LABELS: Record<Scenario, string> = {
  "bad-deploy": "Bad deploy",
  "dependency-outage": "Payment provider down",
  "memory-leak": "Memory leak",
  "noisy-blip": "Noisy blip",
};

export type Confidence = "low" | "medium" | "high";
export type IncidentStatus = "investigating" | "triaged" | "resolved";

/** One claim in a triage note and the link that proves it. */
export interface Evidence {
  claim: string;
  /** A link that reproduces the evidence, usually Grafana Explore. */
  url: string;
  /** The query behind the link, shown alongside it. */
  query: string;
  /** The investigation step whose result proves the claim. */
  step?: number;
}

/** A claim the agent made but could not back with a tool result; dropped from the note. */
export interface DroppedClaim {
  claim: string;
  reason: string;
}

export interface TriageNote {
  summary: string;
  likelyCause: string;
  confidence: Confidence;
  evidence: Evidence[];
  ruledOut: string[];
  nextStep: string;
  runbook?: string;
  /** True when the agent judged the alert to be noise that needs no action. */
  noise: boolean;
  /** Claims removed by verification, kept for transparency. */
  dropped?: DroppedClaim[];
  /** Which planner wrote it: playbook, or the model name. */
  author?: string;
}

export type StepKind = "tool" | "thought" | "note" | "update";

/** One visible step of an investigation, streamed to the Incident Room. */
export interface InvestigationStep {
  id: string;
  incidentId: string;
  at: string;
  kind: StepKind;
  tool?: string;
  title: string;
  detail?: string;
  query?: string;
  url?: string;
  /** Small, display-safe result summary. */
  result?: unknown;
}

export interface Incident {
  id: string;
  title: string;
  service: string;
  alertName: string;
  status: IncidentStatus;
  startedAt: string;
  triagedAt?: string;
  resolvedAt?: string;
  note?: TriageNote;
  /** Scenario that caused it, when known (demo mode only, never shown to the agent). */
  scenario?: Scenario;
  severity?: string;
  /** Every alert name grouped into this incident. */
  alerts?: string[];
  /** Fired, resolved and fired again within a short window. */
  flapping?: boolean;
  investigation?: InvestigationStats;
}

export interface InvestigationStats {
  planner: string;
  toolCalls: number;
  tokens: { input: number; output: number };
  wallMs: number;
  budgetHit?: string;
  traceId?: string;
}
