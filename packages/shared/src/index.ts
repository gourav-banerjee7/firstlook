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
}
