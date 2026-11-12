import { describe, expect, it } from "vitest";
import { SCENARIO_LABELS, SCENARIOS } from "./index.js";

describe("shared", () => {
  it("labels every scenario", () => {
    for (const s of SCENARIOS) expect(SCENARIO_LABELS[s]).toBeTruthy();
  });
});
