import type { Incident, InvestigationStep } from "@firstlook/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordedSource, type RecordedData } from "../lib/source";

const t0 = Date.parse("2026-11-13T00:41:50Z");
const step = (seq: number, offsetMs: number, kind: InvestigationStep["kind"]): InvestigationStep => ({
  id: `inc_1:${seq}`,
  incidentId: "inc_1",
  at: new Date(t0 + offsetMs).toISOString(),
  kind,
  title: `step ${seq}`,
});

const incident: Incident = {
  id: "inc_1",
  title: "High P99 latency on demo-api",
  service: "demo-api",
  alertName: "High P99 latency",
  status: "resolved",
  startedAt: new Date(t0).toISOString(),
  resolvedAt: new Date(t0 + 300_000).toISOString(),
  note: { summary: "s", likelyCause: "c", confidence: "high", evidence: [], ruledOut: [], nextStep: "n", noise: false },
};

const data: RecordedData = {
  capturedAt: "2026-11-13T01:00:00Z",
  planner: "playbook",
  incidents: [
    {
      scenario: "bad-deploy",
      incident,
      steps: [
        step(1, 0, "update"),
        step(2, 45_000, "update"),
        step(3, 45_100, "tool"),
        step(4, 45_200, "note"),
        step(5, 240_000, "update"),
      ],
    },
  ],
};

afterEach(() => vi.useRealTimers());

describe("recorded replay", () => {
  it("streams steps in order and only reveals the note when the note step lands", () => {
    vi.useFakeTimers();
    const steps: string[] = [];
    const states: Array<{ status: string; note: boolean }> = [];
    let done = false;
    recordedSource(data).watch("inc_1", {
      onStep: (s) => steps.push(s.title),
      onIncident: (i) => states.push({ status: i.status, note: Boolean(i.note) }),
      onDone: () => (done = true),
    });
    expect(states[0]).toEqual({ status: "investigating", note: false });
    vi.advanceTimersByTime(300 + 2600 + 450 + 450);
    expect(steps).toEqual(["step 1", "step 2", "step 3", "step 4"]);
    expect(states.at(-1)).toEqual({ status: "triaged", note: true });
    vi.advanceTimersByTime(5000);
    expect(steps).toHaveLength(5);
    expect(done).toBe(true);
    expect(states.at(-1)).toEqual({ status: "resolved", note: true });
  });

  it("stops cleanly", () => {
    vi.useFakeTimers();
    const steps: string[] = [];
    const stop = recordedSource(data).watch("inc_1", {
      onStep: (s) => steps.push(s.title),
      onIncident: () => undefined,
    });
    vi.advanceTimersByTime(400);
    stop();
    vi.advanceTimersByTime(60_000);
    expect(steps).toEqual(["step 1"]);
  });
});
