/**
 * Mirror the eval cases into a Langfuse dataset and attach each eval run's trace to its item, so
 * runs of different models or prompts can be compared side by side in Langfuse. Optional: only
 * used when LANGFUSE_* is set. Uses the public REST API, no SDK.
 */
import type { EvalCase } from "./cases.js";
import { EXPECT } from "./cases.js";

const DATASET = "firstlook-incidents";

export class DatasetSync {
  private auth: string;

  constructor(private cfg: { host: string; publicKey: string; secretKey: string }) {
    this.auth = `Basic ${Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString("base64")}`;
  }

  private async post(path: string, body: unknown) {
    const res = await fetch(new URL(path, this.cfg.host), {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json", authorization: this.auth },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Langfuse ${path} returned ${res.status}`);
  }

  /** Create the dataset and upsert one item per case (item id = case name). */
  async ensure(cases: EvalCase[]) {
    try {
      await this.post("/api/public/v2/datasets", {
        name: DATASET,
        description: "Recorded Firstlook incidents with ground truth",
      });
    } catch {
      // Already exists.
    }
    for (const c of cases) {
      const e = EXPECT[c.scenario];
      await this.post("/api/public/dataset-items", {
        datasetName: DATASET,
        id: `firstlook-${c.name}`,
        input: { alert: c.alert, onset: c.onset },
        expectedOutput: { noise: e.noise, cause: e.cause?.source ?? null, notCause: e.notCause?.source ?? null },
        metadata: { capturedFrom: c.capturedFrom },
      });
    }
  }

  /** Link a trace to its dataset item under a named run, and score it. */
  async link(caseName: string, traceId: string, runName: string, planner: string, pass: boolean) {
    await this.post("/api/public/dataset-run-items", {
      runName: `${runName} · ${planner}`,
      datasetItemId: `firstlook-${caseName}`,
      traceId,
      metadata: { planner },
    });
    await this.post("/api/public/scores", { traceId, name: "eval_pass", value: pass ? 1 : 0 });
  }
}
