"use client";
import { SCENARIO_LABELS, SCENARIOS, type Scenario } from "@firstlook/shared";
import { useState } from "react";
import { cx } from "./ui";

const BLURB: Record<Scenario, string> = {
  "bad-deploy": "Ship v1.4.1 with an unindexed search query.",
  "dependency-outage": "The payment provider starts returning 503s.",
  "memory-leak": "Ship v1.4.2 with an unbounded in-memory cache.",
  "noisy-blip": "45 seconds of connection resets, then nothing.",
};

export function BreakPanel({
  mode,
  available,
  onBreak,
  onReplay,
}: {
  mode: "live" | "recorded";
  /** Recorded mode: which scenarios have a recording. */
  available?: Scenario[];
  onBreak?: (s: Scenario) => Promise<{ ok: boolean; message: string }>;
  onReplay?: (s: Scenario) => void;
}) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<Scenario | null>(null);
  const live = mode === "live";
  return (
    <section className="rounded-xl border border-line bg-panel p-4">
      <h2 className="text-sm font-semibold">{live ? "Break something" : "Replay a real investigation"}</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        {live
          ? "Injects a fault into the demo system. Grafana alerts within about a minute; Firstlook takes it from there."
          : "Each was recorded end to end on the local stack: a real fault, a real Grafana alert, and the agent's real tool calls."}
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {SCENARIOS.map((s) => {
          const disabled = (!live && !available?.includes(s)) || busy !== null;
          return (
            <button
              key={s}
              disabled={disabled}
              onClick={async () => {
                if (!live) return onReplay?.(s);
                setBusy(s);
                setMsg(null);
                const r = await onBreak!(s).catch((e: Error) => ({ ok: false, message: e.message }));
                setMsg({ ok: r.ok, text: r.message });
                setBusy(null);
              }}
              className={cx(
                "rounded-lg border border-line bg-panel-2 p-2.5 text-left transition-colors",
                "hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-40",
              )}
            >
              <span className="block text-[13px] font-medium">{busy === s ? "Starting…" : SCENARIO_LABELS[s]}</span>
              <span className="mt-0.5 block text-[11px] leading-snug text-faint">{BLURB[s]}</span>
            </button>
          );
        })}
      </div>
      {msg && <p className={cx("mt-2 text-xs", msg.ok ? "text-ok" : "text-crit")}>{msg.text}</p>}
    </section>
  );
}
