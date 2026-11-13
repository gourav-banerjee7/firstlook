import { describe, expect, it } from "vitest";
import { capture, replay } from "../src/evals/cassette.js";
import { EXPECT } from "../src/evals/cases.js";
import { grade } from "../src/evals/graders.js";
import { investigate, type StepDraft } from "../src/investigator.js";
import { PlaybookPlanner } from "../src/planner/playbook.js";
import { fixture } from "./fixtures.js";

describe("cassettes", () => {
  it("record once, replay to the same triage note, and grade it", async () => {
    const f = fixture("bad-deploy");
    const now = new Date();
    const cassette = await capture(f.sources, { service: "demo-api", onset: f.onset, now, grafanaUrl: "http://g" });
    const alert = {
      alertName: f.alertName,
      service: "demo-api",
      severity: "critical",
      summary: "x",
      startedAt: f.onset.toISOString(),
    };
    const run = async (sources = f.sources) => {
      const steps: StepDraft[] = [];
      const r = await investigate({
        alert,
        planner: new PlaybookPlanner(),
        ctx: { service: "demo-api", onset: f.onset, grafanaUrl: "http://g", sources },
        budgets: { maxSteps: 8, maxWallMs: 60_000, maxTokens: 1 },
        emit: async (s) => void steps.push(s),
        now: () => now,
      });
      return { r, steps };
    };
    const live = await run();
    const replayed = await run(replay(cassette));
    expect(replayed.r.note).toEqual(live.r.note);
    const grades = grade(
      { note: replayed.r.note, steps: replayed.steps, toolCalls: replayed.r.toolCalls, maxSteps: 8 },
      EXPECT["bad-deploy"],
    );
    expect(grades.filter((g) => !g.pass)).toEqual([]);
  });

  it("never serves deploys from after the incident", async () => {
    const f = fixture("memory-leak");
    const cassette = await capture(f.sources, {
      service: "demo-api",
      onset: f.onset,
      now: new Date(f.onset.getTime() - 60_000),
      grafanaUrl: "http://g",
    });
    expect(cassette.deploys.every((d) => new Date(d.at) <= new Date(f.onset.getTime() - 60_000))).toBe(true);
  });

  it("fails loudly on a query that was never recorded", async () => {
    await expect(
      replay({ prom: {}, logs: {}, traces: {}, spans: {}, deploys: [] }).promRange("up", new Date(0), new Date(), 15),
    ).rejects.toThrow(/not in the recording/);
  });
});

describe("graders", () => {
  const base = { steps: [], toolCalls: 3, maxSteps: 8 };
  const note = {
    summary: "s",
    likelyCause: "Release 1.4.0 broke it",
    confidence: "high" as const,
    evidence: [],
    ruledOut: [],
    nextStep: "n",
    noise: false,
  };
  it("catches a decoy cause and a wrong noise verdict", () => {
    const g = grade({ ...base, note }, EXPECT["noisy-blip"]);
    expect(g.find((x) => x.grader === "noise")?.pass).toBe(false);
    const o = grade({ ...base, note: { ...note, summary: "payments-stub" } }, EXPECT["dependency-outage"]);
    expect(o.find((x) => x.grader === "cause")?.detail).toMatch(/decoy/);
  });
  it("fails a note whose claims had to be dropped", () => {
    const g = grade(
      { ...base, note: { ...note, noise: true, dropped: [{ claim: "c", reason: "9 not found" }] } },
      EXPECT["noisy-blip"],
    );
    expect(g.find((x) => x.grader === "numbers")?.pass).toBe(false);
  });
});
