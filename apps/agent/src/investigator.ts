/**
 * The investigation loop: ask the planner for one action, validate it, run the tool, repeat,
 * until the planner finishes or a budget runs out. Every step is emitted as it happens so the
 * Incident Room can stream it.
 *
 * Budgets are hard: max tool calls, wall time, and tokens. When one runs out the planner is told
 * it must finish, and if it still won't, the playbook writes the note from what was gathered.
 */
import type { InvestigationStep, TriageNote } from "@firstlook/shared";
import type { TraceHandle } from "./langfuse.js";
import { conclude, PlaybookPlanner } from "./planner/playbook.js";
import { ActionSchema, type AlertContext, type HistoryItem, type Planner, type PlannerInput } from "./planner/types.js";
import { clean, containsInjection } from "./sanitize.js";
import { toolByName, type ToolContext } from "./tools.js";
import { verifyNote, type VerifiableStep } from "./verify.js";

export type StepDraft = Omit<InvestigationStep, "id" | "incidentId" | "at">;

export interface Budgets {
  maxSteps: number;
  maxWallMs: number;
  maxTokens: number;
}

export interface InvestigateOptions {
  alert: AlertContext;
  runbook?: string;
  planner: Planner;
  ctx: Omit<ToolContext, "now">;
  budgets: Budgets;
  emit: (step: StepDraft) => Promise<void>;
  trace?: TraceHandle;
}

export interface InvestigationResult {
  note: TriageNote;
  toolCalls: number;
  tokens: { input: number; output: number };
  planner: string;
  budgetHit?: string;
  wallMs: number;
}

const TITLES: Record<string, (a: Record<string, unknown>) => string> = {
  metric_overview: (a) => `Looked at ${String(a.signal).replace("_", " ")} around onset`,
  metric_breakdown: (a) => `Split ${String(a.signal).replace("_", " ")} by ${String(a.by)}`,
  error_logs: (a) => `Read warning and error logs${a.service ? ` from ${String(a.service)}` : ""}`,
  slow_traces: () => "Found the slowest requests",
  recent_changes: () => "Checked recent deploys",
  dependency_health: () => "Checked downstream dependencies",
};

export async function investigate(opts: InvestigateOptions): Promise<InvestigationResult> {
  const { alert, budgets, emit, trace } = opts;
  const started = Date.now();
  const history: HistoryItem[] = [];
  const verifiable: VerifiableStep[] = [];
  const tokens = { input: 0, output: 0 };
  let planner = opts.planner;
  let correction: string | undefined;
  let rejects = 0;
  let budgetHit: string | undefined;

  const fallBack = async (why: string) => {
    if (planner.name === "playbook") return;
    planner = new PlaybookPlanner();
    await emit({ kind: "update", title: "Switched to the built-in playbook", detail: why });
  };

  for (let turn = 0; turn < budgets.maxSteps + 6; turn++) {
    const elapsed = Date.now() - started;
    if (!budgetHit) {
      if (history.length >= budgets.maxSteps) budgetHit = `tool-call budget (${budgets.maxSteps}) used`;
      else if (elapsed > budgets.maxWallMs - 15_000)
        budgetHit = `time budget (${Math.round(budgets.maxWallMs / 1000)} s) nearly used`;
      else if (tokens.input + tokens.output >= budgets.maxTokens)
        budgetHit = `token budget (${budgets.maxTokens}) used`;
      if (budgetHit) await emit({ kind: "update", title: "Budget reached, writing the note", detail: budgetHit });
    }

    const input: PlannerInput = {
      alert,
      history,
      remainingSteps: Math.max(0, budgets.maxSteps - history.length),
      mustFinish: Boolean(budgetHit),
      ...(correction ? { correction } : {}),
    };

    const t0 = new Date();
    let raw: unknown;
    try {
      const reply = await planner.next(input);
      raw = reply.action;
      tokens.input += reply.usage.input;
      tokens.output += reply.usage.output;
      if (planner.name !== "playbook") {
        trace?.generation({
          name: `turn ${turn + 1}`,
          model: reply.model,
          start: t0,
          end: new Date(),
          input: reply.prompt,
          output: reply.completion,
          usage: reply.usage,
        });
      }
    } catch (err) {
      await fallBack(`${planner.name} failed: ${clean((err as Error).message, 120)}`);
      continue;
    }

    const parsed = ActionSchema.safeParse(raw);
    if (!parsed.success) {
      correction = `invalid action: ${clean(parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "), 200)}`;
      if (++rejects > 2) await fallBack("the model kept returning invalid actions");
      continue;
    }
    const action = parsed.data;

    if (action.type === "finish") {
      const note = verifyNote(action.note, verifiable, {
        ...(opts.runbook ? { runbook: opts.runbook } : {}),
        author: planner.name === "playbook" ? "playbook" : ((planner as { model?: string }).model ?? planner.name),
      });
      await emit({
        kind: "note",
        title: note.noise ? "Judged as noise" : "Triage note ready",
        detail: note.summary,
        result: note,
      });
      const wallMs = Date.now() - started;
      await trace?.end(note, { toolCalls: history.length, tokens, budgetHit, wallMs, planner: planner.name });
      return {
        note,
        toolCalls: history.length,
        tokens,
        planner: planner.name,
        ...(budgetHit ? { budgetHit } : {}),
        wallMs,
      };
    }

    // ---- a tool call -----------------------------------------------------------------------
    if (budgetHit) {
      correction = "you are out of tool calls; reply with a finish action";
      if (++rejects > 2) await fallBack("the model would not stop calling tools after its budget ran out");
      continue;
    }
    const tool = toolByName(action.tool);
    if (!tool) {
      correction = `"${clean(action.tool, 40)}" is not a tool; use one of the declared tools`;
      if (++rejects > 2) await fallBack("the model kept calling undeclared tools");
      continue;
    }
    const args = tool.args.safeParse(action.args);
    if (!args.success) {
      correction = `bad args for ${tool.name}: ${clean(args.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "), 200)}`;
      if (++rejects > 2) await fallBack("the model kept sending invalid tool arguments");
      continue;
    }
    const argKey = JSON.stringify(args.data);
    const repeat = history.find((h) => h.tool === tool.name && JSON.stringify(h.args) === argKey);
    if (repeat) {
      correction = `you already ran ${tool.name} with these args in step ${repeat.step}`;
      if (++rejects > 2) await fallBack("the model kept repeating the same call");
      continue;
    }
    correction = undefined;

    const step = history.length + 1;
    const callStart = new Date();
    const item: HistoryItem = { step, tool: tool.name, args: args.data as Record<string, unknown> };
    let url: string | undefined;
    let query: string | undefined;
    try {
      const out = await tool.run({ ...opts.ctx, now: new Date() }, args.data);
      item.summary = out.summary;
      item.data = out.data;
      item.suspicious = containsInjection(out.data) || containsInjection(out.summary);
      url = out.url;
      query = out.query;
    } catch (err) {
      item.error = clean((err as Error).message, 160);
    }
    history.push(item);
    verifiable.push({
      step,
      tool: tool.name,
      ...(item.summary ? { summary: item.summary } : {}),
      data: item.data,
      ...(item.error ? { error: item.error } : {}),
      ...(url ? { url } : {}),
      ...(query ? { query } : {}),
    });
    trace?.span(
      tool.name,
      callStart,
      new Date(),
      args.data,
      item.error ?? { summary: item.summary, data: item.data },
      item.error ? "ERROR" : item.suspicious ? "WARNING" : "DEFAULT",
    );

    await emit({
      kind: "tool",
      tool: tool.name,
      title: (TITLES[tool.name] ?? (() => tool.name))(item.args),
      detail: item.error ? `Failed: ${item.error}` : item.summary,
      ...(query ? { query } : {}),
      ...(url ? { url } : {}),
      result: {
        step,
        reason: clean(action.reason, 300),
        data: item.data,
        ...(item.suspicious ? { suspicious: true } : {}),
      },
    });
    if (item.suspicious) {
      await emit({
        kind: "update",
        title: "Ignored instruction-like text in the data",
        detail: `Step ${step}'s result contains text that reads like instructions. It was treated as data only.`,
      });
    }
  }

  // The loop guard tripped: write the note from what we have, deterministically.
  const draft = conclude({ alert, history, remainingSteps: 0, mustFinish: true });
  const note = verifyNote(draft, verifiable, {
    ...(opts.runbook ? { runbook: opts.runbook } : {}),
    author: "playbook",
  });
  await emit({ kind: "note", title: "Triage note ready", detail: note.summary, result: note });
  const wallMs = Date.now() - started;
  await trace?.end(note, { toolCalls: history.length, tokens, budgetHit: budgetHit ?? "turn limit", wallMs });
  return { note, toolCalls: history.length, tokens, planner: "playbook", budgetHit: budgetHit ?? "turn limit", wallMs };
}
