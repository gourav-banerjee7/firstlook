import type { Confidence, Incident } from "@firstlook/shared";

export const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(" ");

export function clock(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function ago(iso: string, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function StatusPill({ incident }: { incident: Incident }) {
  const s = incident.status;
  const noise = incident.note?.noise;
  const style =
    s === "investigating"
      ? "bg-dawn-dim text-dawn"
      : s === "resolved"
        ? "bg-ok-dim text-ok"
        : noise
          ? "bg-noise-dim text-noise"
          : "bg-warn-dim text-warn";
  const label = s === "investigating" ? "Investigating" : s === "resolved" ? "Resolved" : noise ? "Noise" : "Triaged";
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium", style)}>
      {s === "investigating" && <span className="pulse-dot size-1.5 rounded-full bg-dawn" />}
      {label}
    </span>
  );
}

export function SeverityDot({ severity }: { severity?: string }) {
  return (
    <span
      title={severity ?? "warning"}
      className={cx("inline-block size-2 shrink-0 rounded-full", severity === "critical" ? "bg-crit" : "bg-warn")}
    />
  );
}

export function ConfidenceChip({ c }: { c: Confidence }) {
  const style =
    c === "high" ? "border-ok/40 text-ok" : c === "medium" ? "border-warn/40 text-warn" : "border-crit/40 text-crit";
  return <span className={cx("rounded-md border px-2 py-0.5 text-xs font-medium", style)}>{c} confidence</span>;
}

const TOOL_GLYPH: Record<string, string> = {
  metric_overview: "M2 12l3-4 3 2 4-6 2 3",
  metric_breakdown: "M3 14V8M7 14V4M11 14v-4M15 14V6",
  error_logs: "M3 4h12M3 8h12M3 12h8",
  slow_traces: "M2 4h6M5 8h8M9 12h6",
  recent_changes: "M9 2v4M9 12v4M9 6a3 3 0 110 6 3 3 0 010-6",
  dependency_health: "M4 9h4M10 9h4M8 9a1 1 0 102 0 1 1 0 10-2 0M3 5v8M15 5v8",
};

export function StepIcon({ kind, tool }: { kind: string; tool?: string }) {
  if (kind === "tool" && tool && TOOL_GLYPH[tool]) {
    return (
      <span className="grid size-7 shrink-0 place-items-center rounded-md border border-line-strong bg-panel-2 text-dawn">
        <svg
          viewBox="0 0 18 18"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d={TOOL_GLYPH[tool]} />
        </svg>
      </span>
    );
  }
  if (kind === "note") {
    return (
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-dawn text-dawn-ink">
        <svg
          viewBox="0 0 18 18"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M4 9.5l3 3 7-7" />
        </svg>
      </span>
    );
  }
  return (
    <span className="grid size-7 shrink-0 place-items-center">
      <span className="size-2 rounded-full bg-line-strong" />
    </span>
  );
}

export function Logo() {
  return (
    <svg viewBox="0 0 28 28" className="size-7" aria-hidden>
      <rect width="28" height="28" rx="7" fill="#151922" stroke="#323a4d" />
      <path d="M6 18.5h16" stroke="#5d6577" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M9 18.5a5 5 0 0110 0" fill="none" stroke="#8ab4ff" strokeWidth="2" strokeLinecap="round" />
      <path
        d="M14 8.5v2.2M8.2 10.9l1.4 1.5M19.8 10.9l-1.4 1.5"
        stroke="#8ab4ff"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
