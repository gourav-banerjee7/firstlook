"use client";
import type { Incident, InvestigationStep, Scenario } from "@firstlook/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createSource, RECORDED, type Source } from "@/lib/source";
import { BreakPanel } from "./BreakPanel";
import { IncidentList } from "./IncidentList";
import { Timeline } from "./Timeline";
import { TriageCard } from "./TriageCard";
import { ago, cx, Logo, SeverityDot, StatusPill } from "./ui";

const REPO = "https://github.com/gourav-banerjee7/firstlook";

export function Room() {
  const source: Source = useMemo(() => createSource(), []);
  const live = source.mode === "live";
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [selected, setSelected] = useState<string>();
  const [current, setCurrent] = useState<Incident>();
  const [steps, setSteps] = useState<InvestigationStep[]>([]);
  const [replaying, setReplaying] = useState(false);
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const stop = useRef<() => void>(undefined);

  const scenarioOf = useCallback(
    (id?: string) => (live ? undefined : RECORDED.incidents.find((r) => r.incident.id === id)?.scenario),
    [live],
  );

  // Incident list: polled live; static when recorded.
  useEffect(() => {
    let alive = true;
    const load = () =>
      source
        .list()
        .then((xs) => {
          if (!alive) return;
          setIncidents(xs);
          setError(undefined);
          const fromUrl = new URLSearchParams(window.location.search).get("incident");
          setSelected((cur) => cur ?? (fromUrl && xs.some((x) => x.id === fromUrl) ? fromUrl : xs[0]?.id));
        })
        .catch((e: Error) => alive && setError(`Can't reach the agent: ${e.message}`));
    void load();
    const t = live ? setInterval(load, 4000) : undefined;
    const c = setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      alive = false;
      if (t) clearInterval(t);
      clearInterval(c);
    };
  }, [source, live]);

  const open = useCallback(
    (id: string, replay: boolean) => {
      stop.current?.();
      setSelected(id);
      setSteps([]);
      setCurrent(undefined);
      if (!live && !replay) {
        // Recorded, no replay: show the finished investigation at once.
        void source.detail(id).then((d) => {
          if (!d) return;
          setCurrent(d.incident);
          setSteps(d.steps);
        });
        setReplaying(false);
        return;
      }
      setReplaying(!live);
      stop.current = source.watch(id, {
        onStep: (s) => setSteps((xs) => (xs.some((x) => x.id === s.id) ? xs : [...xs, s])),
        onIncident: (i) => setCurrent(i),
        onDone: () => setReplaying(false),
      });
    },
    [live, source],
  );

  // Follow the selection.
  const opened = useRef<string>(undefined);
  useEffect(() => {
    if (selected && opened.current !== selected) {
      opened.current = selected;
      window.history.replaceState(null, "", `?incident=${encodeURIComponent(selected)}`);
      open(selected, live);
    }
  }, [selected, open, live]);
  useEffect(() => () => stop.current?.(), []);

  const replay = (s: Scenario) => {
    const rec = RECORDED.incidents.find((r) => r.scenario === s);
    if (!rec) return;
    opened.current = rec.incident.id;
    open(rec.incident.id, true);
  };

  const inc = current ?? incidents.find((i) => i.id === selected);
  const investigating = live ? inc?.status === "investigating" : replaying && !inc?.note;
  const scenario = scenarioOf(inc?.id);

  return (
    <div className="mx-auto max-w-[1400px] px-4 pb-16 sm:px-6">
      <header className="flex flex-wrap items-center gap-3 py-5">
        <Logo />
        <div>
          <h1 className="text-[15px] leading-tight font-semibold">Firstlook</h1>
          <p className="text-xs text-muted">The first responder that shows its work</p>
        </div>
        <span
          className={cx(
            "ml-auto rounded-full border px-2.5 py-1 text-[11px]",
            live ? "border-ok/40 text-ok" : "border-line-strong text-muted",
          )}
          title={
            live
              ? "Connected to a running Firstlook agent"
              : `Recorded ${RECORDED.capturedAt ? new Date(RECORDED.capturedAt).toLocaleDateString() : ""} on the local stack`
          }
        >
          {live ? "● Live" : "Recorded demo"}
        </span>
        <a href={REPO} target="_blank" rel="noreferrer" className="text-xs text-muted hover:text-ink">
          GitHub ↗
        </a>
      </header>

      {!live && (
        <p className="mb-5 rounded-lg border border-line bg-panel px-4 py-3 text-xs leading-relaxed text-muted">
          This public page replays investigations recorded from a real run: Grafana fired real alerts at a running
          agent, which queried Prometheus, Loki and Tempo. Grafana links point at that local stack.{" "}
          <a href={`${REPO}#run-it-yourself`} className="text-dawn hover:underline">
            Run it yourself
          </a>{" "}
          to break things live.
        </p>
      )}
      {error && (
        <p className="mb-4 rounded-lg border border-crit/40 bg-crit-dim px-4 py-3 text-sm text-crit">{error}</p>
      )}

      <div className="grid gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="space-y-5">
          <BreakPanel
            mode={source.mode}
            available={RECORDED.incidents.map((r) => r.scenario)}
            {...(source.breakIt ? { onBreak: source.breakIt } : {})}
            onReplay={replay}
          />
          <section className="overflow-hidden rounded-xl border border-line bg-panel">
            <h2 className="border-b border-line px-4 py-3 text-sm font-semibold">Incidents</h2>
            <IncidentList
              incidents={incidents}
              {...(selected ? { selected } : {})}
              onSelect={(id) => setSelected(id)}
              now={now}
            />
          </section>
        </aside>

        <main className="min-w-0">
          {inc ? (
            <>
              <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2">
                <SeverityDot severity={inc.severity} />
                <h2 className="text-lg font-semibold">{inc.alertName}</h2>
                <StatusPill incident={inc} />
                <span className="font-mono text-xs text-muted">{inc.service}</span>
                {inc.flapping && (
                  <span className="rounded bg-warn-dim px-1.5 py-0.5 text-[11px] text-warn">flapping</span>
                )}
                <span className="text-xs text-faint">started {ago(inc.startedAt, now)}</span>
                {!live && !replaying && (
                  <button onClick={() => open(inc.id, true)} className="ml-auto text-xs text-dawn hover:underline">
                    ↻ Replay investigation
                  </button>
                )}
                {!live && replaying && (
                  <button onClick={() => open(inc.id, false)} className="ml-auto text-xs text-muted hover:text-ink">
                    Skip to result
                  </button>
                )}
              </div>
              <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
                <section className="rounded-xl border border-line bg-panel p-5">
                  <h3 className="mb-4 text-[11px] font-semibold tracking-wider text-faint uppercase">Investigation</h3>
                  <Timeline steps={steps} live={Boolean(investigating)} linksLive={live} />
                </section>
                <div className="xl:sticky xl:top-5 xl:self-start">
                  <TriageCard
                    key={inc.id}
                    incident={inc}
                    {...(scenario ? { scenario } : {})}
                    linksLive={live}
                    {...(source.feedback ? { onFeedback: (h: boolean) => source.feedback!(inc.id, h) } : {})}
                  />
                </div>
              </div>
            </>
          ) : (
            <div className="grid min-h-[50vh] place-items-center rounded-xl border border-dashed border-line text-sm text-muted">
              {live ? "No incidents yet. Break something on the left." : "Pick a recording to replay."}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
