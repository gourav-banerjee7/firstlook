/**
 * Prompt-injection hardening for tool output. Anything that came from the monitored system
 * (log lines, span names, deploy descriptions) is attacker-reachable text: a user can put
 * "ignore your instructions" in a booking note and it will end up in a log line.
 *
 * So tool output is (1) stripped of control characters, (2) truncated, (3) passed to the model
 * as JSON inside a clearly labelled data block, and (4) scanned for instruction-like phrases,
 * which are flagged on the step rather than silently passed through.
 */

// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g;

export function clean(text: unknown, max = 200): string {
  const s = String(text ?? "")
    .replace(CONTROL, "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const SUSPICIOUS = [
  /ignore (all |any |the )?(previous|prior|above|earlier) (instructions|prompts?)/i,
  /disregard (your|the|all) (instructions|rules|system prompt)/i,
  /\byou are now\b/i,
  /\bsystem prompt\b/i,
  /<\/?(system|assistant|tool_result|untrusted)[^>]*>/i,
  /\b(call|use|run) the \w+ tool\b/i,
  /\bmark (this|the incident) as (noise|resolved)\b/i,
];

export function looksLikeInjection(text: string): boolean {
  return SUSPICIOUS.some((r) => r.test(text));
}

/** Walk a tool result and return true if any string in it looks like an instruction. */
export function containsInjection(value: unknown): boolean {
  if (typeof value === "string") return looksLikeInjection(value);
  if (Array.isArray(value)) return value.some(containsInjection);
  if (value && typeof value === "object") return Object.values(value).some(containsInjection);
  return false;
}

/** How a tool result is shown to the model: quoted data with an explicit warning label. */
export function asUntrustedBlock(stepNumber: number, tool: string, payload: unknown): string {
  const json = JSON.stringify(payload).replace(/<\/untrusted_data/gi, "<\\/untrusted_data");
  return `<untrusted_data step="${stepNumber}" tool="${tool}">\n${json}\n</untrusted_data>`;
}
