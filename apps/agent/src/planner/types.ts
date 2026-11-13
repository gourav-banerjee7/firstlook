import { z } from "zod";

/** What the model may say: call one declared tool, or finish with a note. Nothing else parses. */
export const DraftNoteSchema = z.object({
  summary: z.string().min(1).max(400),
  likely_cause: z.string().min(1).max(400),
  confidence: z.enum(["low", "medium", "high"]),
  evidence: z.array(z.object({ claim: z.string().min(1).max(300), step: z.number().int().min(1) })).max(6),
  ruled_out: z.array(z.string().max(200)).max(5).default([]),
  next_step: z.string().min(1).max(300),
  noise: z.boolean(),
});
export type DraftNote = z.infer<typeof DraftNoteSchema>;

export const ActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("call"),
    tool: z.string(),
    args: z.record(z.string(), z.unknown()).default({}),
    reason: z.string().max(300).default(""),
  }),
  z.object({ type: z.literal("finish"), note: DraftNoteSchema }),
]);
export type Action = z.infer<typeof ActionSchema>;

export interface AlertContext {
  alertName: string;
  service: string;
  severity: string;
  summary: string;
  startedAt: string;
}

export interface HistoryItem {
  step: number;
  tool: string;
  args: Record<string, unknown>;
  summary?: string;
  data?: unknown;
  error?: string;
  suspicious?: boolean;
}

export interface PlannerInput {
  alert: AlertContext;
  history: HistoryItem[];
  remainingSteps: number;
  /** True on the last allowed turn: the planner must return a finish action. */
  mustFinish: boolean;
  /** Set when the previous reply failed validation, so the model can correct itself. */
  correction?: string;
}

export interface PlannerReply {
  /** Raw, unvalidated action. The investigator validates it. */
  action: unknown;
  usage: { input: number; output: number };
  /** Text actually sent to/received from the model, for tracing. */
  prompt?: string;
  completion?: string;
  model: string;
}

export interface Planner {
  name: string;
  next(input: PlannerInput): Promise<PlannerReply>;
}
