"use client";
import type { Incident, Scenario } from "@firstlook/shared";
import { SCENARIO_LABELS } from "@firstlook/shared";
import { useState } from "react";
import { ConfidenceChip, cx } from "./ui";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5">
      <h3 className="mb-2 text-[11px] font-semibold tracking-wider text-faint uppercase">{title}</h3>
      {children}
    </section>
  );
}

export function TriageCard({
  incident,
  scenario,
  linksLive,
  onFeedback,
}: {
  incident: Incident;
  scenario?: Scenario;
  linksLive: boolean;
  onFeedback?: (helpful: boolean) => Promise<void>;
}) {
  const [reveal, setReveal] = useState(false);
  const [voted, setVoted] = useState<boolean | null>(null);
  const n = incident.note;

  if (!n) {
    return (
      <div className="rounded-xl border border-line bg-panel p-5">
        <p className="text-sm text-muted">The triage note appears here when the investigation finishes.</p>
        <div className="mt-4 space-y-2">
          {[80, 60, 70].map((w) => (
            <div key={w} className="pulse-dot h-3 rounded bg-panel-3" style={{ width: `${w}%` }} />
          ))}
        </div>
      </div>
    );
  }

  const stats = incident.investigation;
  return (
    <article className="step-in rounded-xl border border-line bg-panel p-5">
      <div className="flex flex-wrap items-center gap-2">
        {n.noise ? (
          <span className="rounded-md border border-noise/40 px-2 py-0.5 text-xs font-medium text-noise">
            noise · no action needed
          </span>
        ) : (
          <ConfidenceChip c={n.confidence} />
        )}
        {n.noise && <ConfidenceChip c={n.confidence} />}
        <span className="ml-auto text-[11px] text-faint">
          by {n.author === "playbook" ? "built-in playbook" : n.author}
        </span>
      </div>

      <p className="mt-4 text-[17px] leading-snug font-semibold text-balance">{n.summary}</p>

      <Section title="Likely cause">
        <p className="text-sm leading-relaxed">{n.likelyCause}</p>
      </Section>

      <Section title={`Evidence (${n.evidence.length})`}>
        {n.evidence.length ? (
          <ol className="space-y-2.5">
            {n.evidence.map((e, i) => (
              <li key={i} className="flex gap-2.5 text-sm leading-relaxed">
                <span className="mt-0.5 font-mono text-[11px] text-faint">{i + 1}.</span>
                <div className="min-w-0">
                  <span>{e.claim}</span>{" "}
                  <a
                    href={e.url}
                    target="_blank"
                    rel="noreferrer"
                    className={cx("text-xs whitespace-nowrap hover:underline", linksLive ? "text-dawn" : "text-faint")}
                    title={linksLive ? e.query : `Recorded on a local stack. Query: ${e.query}`}
                  >
                    step {e.step} ↗
                  </a>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted">No claim could be backed by a tool result.</p>
        )}
      </Section>

      {n.ruledOut.length > 0 && (
        <Section title="Ruled out">
          <ul className="space-y-1 text-sm text-muted">
            {n.ruledOut.map((r, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-faint">–</span>
                {r}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Next step">
        <p className="rounded-lg border border-dawn/25 bg-dawn-dim/60 p-3 text-sm leading-relaxed">{n.nextStep}</p>
        {n.runbook && (
          <a
            href={n.runbook}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block text-xs text-dawn hover:underline"
          >
            Runbook ↗
          </a>
        )}
      </Section>

      {n.dropped && n.dropped.length > 0 && (
        <details className="mt-5 rounded-lg border border-line bg-panel-2 p-3 text-xs">
          <summary className="cursor-pointer text-muted">Removed by verification ({n.dropped.length})</summary>
          <ul className="mt-2 space-y-1.5 text-faint">
            {n.dropped.map((d, i) => (
              <li key={i}>
                <span className="text-muted line-through">{d.claim}</span> — {d.reason}
              </li>
            ))}
          </ul>
        </details>
      )}

      {stats && (
        <dl className="mt-5 grid grid-cols-3 gap-2 border-t border-line pt-4 text-center">
          {[
            ["tool calls", String(stats.toolCalls)],
            ["time", `${(stats.wallMs / 1000).toFixed(1)}s`],
            [
              "tokens",
              stats.tokens.input + stats.tokens.output
                ? (stats.tokens.input + stats.tokens.output).toLocaleString()
                : "0 · no LLM",
            ],
          ].map(([k, v]) => (
            <div key={k}>
              <dd className="font-mono text-sm">{v}</dd>
              <dt className="text-[11px] text-faint">{k}</dt>
            </div>
          ))}
        </dl>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
        {onFeedback && (
          <>
            <span className="text-faint">Was this useful?</span>
            {[true, false].map((v) => (
              <button
                key={String(v)}
                disabled={voted !== null}
                onClick={async () => {
                  setVoted(v);
                  await onFeedback(v).catch(() => setVoted(null));
                }}
                className={cx(
                  "rounded-md border px-2 py-1 transition-colors disabled:cursor-default",
                  voted === v ? "border-dawn text-dawn" : "border-line text-muted hover:border-line-strong",
                )}
              >
                {v ? "Yes" : "No"}
              </button>
            ))}
          </>
        )}
        {scenario && (
          <button onClick={() => setReveal(!reveal)} className="ml-auto text-dawn hover:underline">
            {reveal ? `Injected fault: ${SCENARIO_LABELS[scenario]}` : "What was actually broken?"}
          </button>
        )}
      </div>
    </article>
  );
}
