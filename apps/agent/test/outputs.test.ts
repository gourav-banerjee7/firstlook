import type { Incident, TriageNote } from "@firstlook/shared";
import { describe, expect, it } from "vitest";
import { issueBody } from "../src/outputs.js";
import { BreakItLimiter } from "../src/ratelimit.js";

describe("break-it rate limits", () => {
  it("enforces a global cooldown and a per-IP hourly cap", () => {
    const l = new BreakItLimiter(60_000, 2);
    const t = 1_000_000;
    expect(l.check("a", t).ok).toBe(true);
    l.record("a", t);
    expect(l.check("b", t + 30_000)).toMatchObject({ ok: false, retryAfterSeconds: 30 });
    expect(l.check("b", t + 61_000).ok).toBe(true);
    l.record("a", t + 61_000);
    expect(l.check("a", t + 200_000)).toMatchObject({ ok: false, reason: "Hourly limit reached" });
    expect(l.check("b", t + 200_000).ok).toBe(true);
    expect(l.check("a", t + 3_600_001).ok).toBe(true);
  });
});

describe("GitHub issue body", () => {
  const inc: Incident = {
    id: "inc_1",
    title: "t",
    service: "demo-api",
    alertName: "High P99 latency",
    status: "triaged",
    startedAt: "2026-11-13T00:29:00Z",
  };
  const note: TriageNote = {
    summary: "demo-api slowed down after 1.4.1.",
    likelyCause: "Release 1.4.1.",
    confidence: "high",
    evidence: [{ claim: "p99 went from 40 ms to 950 ms", url: "http://g/explore?x", query: "q", step: 1 }],
    ruledOut: ["Dependencies healthy."],
    nextStep: "Roll back.",
    noise: false,
    dropped: [{ claim: "p99 is 4000 ms", reason: "4000 not found in step 1" }],
  };
  it("renders evidence links, dropped claims and a link back", () => {
    const md = issueBody(inc, note, "https://room.example/");
    expect(md).toContain("1. p99 went from 40 ms to 950 ms ([query](http://g/explore?x))");
    expect(md).toContain("~~p99 is 4000 ms~~ — 4000 not found in step 1");
    expect(md).toContain("[Open in the Incident Room](https://room.example/?incident=inc_1)");
  });
});
