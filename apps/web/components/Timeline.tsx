"use client";
import type { InvestigationStep } from "@firstlook/shared";
import { useState } from "react";
import { clock, cx, StepIcon } from "./ui";

interface ToolResult {
  step?: number;
  reason?: string;
  suspicious?: boolean;
}

function ToolStep({ s, linksLive }: { s: InvestigationStep; linksLive: boolean }) {
  const [open, setOpen] = useState(false);
  const r = (s.result ?? {}) as ToolResult;
  const failed = s.detail?.startsWith("Failed:");
  return (
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-[11px] text-faint">#{r.step}</span>
        <span className="text-sm font-medium">{s.title}</span>
        {r.suspicious && (
          <span
            className="rounded bg-warn-dim px-1.5 py-0.5 text-[10px] font-medium text-warn"
            title="Instruction-like text in the data was treated as data"
          >
            injection attempt ignored
          </span>
        )}
      </div>
      {r.reason && <p className="mt-0.5 text-xs italic text-faint">{r.reason}</p>}
      {s.detail && (
        <p className={cx("mt-1.5 text-[13px] leading-relaxed", failed ? "text-crit" : "text-muted")}>{s.detail}</p>
      )}
      {s.query && (
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
          <button onClick={() => setOpen(!open)} className="text-dawn hover:underline" aria-expanded={open}>
            {open ? "Hide query" : "Show query"}
          </button>
          {s.url && (
            <a
              href={s.url}
              target="_blank"
              rel="noreferrer"
              className={cx("hover:underline", linksLive ? "text-dawn" : "text-faint")}
              title={
                linksLive
                  ? "Open this exact query in Grafana"
                  : "Recorded on a local stack: this link opens Grafana on localhost:3000"
              }
            >
              Open in Grafana ↗
            </a>
          )}
        </div>
      )}
      {open && s.query && (
        <pre className="mt-2 overflow-x-auto rounded-md border border-line bg-bg p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-all text-muted">
          {s.query}
        </pre>
      )}
    </div>
  );
}

export function Timeline({
  steps,
  live,
  linksLive,
}: {
  steps: InvestigationStep[];
  live: boolean;
  linksLive: boolean;
}) {
  return (
    <ol className="relative space-y-4">
      <span aria-hidden className="absolute top-2 bottom-2 left-[13.5px] w-px bg-line" />
      {steps.map((s) => (
        <li key={s.id} className="step-in relative flex gap-3">
          <StepIcon kind={s.kind} {...(s.tool ? { tool: s.tool } : {})} />
          {s.kind === "tool" ? (
            <ToolStep s={s} linksLive={linksLive} />
          ) : (
            <div className="min-w-0 flex-1 pt-1">
              <div className="flex items-baseline gap-2">
                <span className={cx("text-sm", s.kind === "note" ? "font-semibold text-dawn" : "text-ink")}>
                  {s.title}
                </span>
                <span className="ml-auto shrink-0 font-mono text-[11px] text-faint">{clock(s.at)}</span>
              </div>
              {s.detail && s.kind !== "note" && <p className="mt-0.5 text-xs leading-relaxed text-muted">{s.detail}</p>}
            </div>
          )}
        </li>
      ))}
      {live && (
        <li className="relative flex items-center gap-3 text-sm text-muted">
          <span className="grid size-7 place-items-center">
            <span className="pulse-dot size-2 rounded-full bg-dawn" />
          </span>
          Investigating…
        </li>
      )}
    </ol>
  );
}
