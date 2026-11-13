/**
 * An eval case: one real incident (alert + cassette) and what a correct triage note must say.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Scenario } from "@firstlook/shared";
import type { AlertContext } from "../planner/types.js";
import type { Cassette } from "./cassette.js";

export interface Expectation {
  noise: boolean;
  /** Must appear in the summary or likely cause. */
  cause?: RegExp;
  /** Must not appear in the likely cause (the decoys). */
  notCause?: RegExp;
}

/** Ground truth per scenario. The agent never sees this. */
export const EXPECT: Record<Scenario, Expectation> = {
  "bad-deploy": { noise: false, cause: /1\.4\.1/, notCause: /payments-stub/ },
  "dependency-outage": { noise: false, cause: /payments-stub/, notCause: /release|1\.4\.\d/i },
  "memory-leak": { noise: false, cause: /1\.4\.2/ },
  "noisy-blip": { noise: true, notCause: /release|1\.4\.\d/i },
};

export interface EvalCase {
  name: string;
  scenario: Scenario;
  alert: AlertContext;
  runbook?: string;
  /** When the alert started, and when the live investigation ran. */
  onset: string;
  now: string;
  capturedFrom: { incidentId: string; at: string };
  cassette: Cassette;
}

export const CASES_DIR = new URL("../../evals/cases/", import.meta.url);

export function loadCases(dir = CASES_DIR): EvalCase[] {
  const path = dir instanceof URL ? dir.pathname : dir;
  return readdirSync(path)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(path, f), "utf8")) as EvalCase);
}
