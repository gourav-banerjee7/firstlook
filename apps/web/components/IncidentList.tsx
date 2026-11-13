"use client";
import type { Incident } from "@firstlook/shared";
import { ago, cx, SeverityDot, StatusPill } from "./ui";

export function IncidentList({
  incidents,
  selected,
  onSelect,
  now,
}: {
  incidents: Incident[];
  selected?: string;
  onSelect: (id: string) => void;
  now: number;
}) {
  if (!incidents.length) {
    return <p className="px-4 py-6 text-sm text-muted">No incidents yet. Break something to see Firstlook work.</p>;
  }
  return (
    <ul className="divide-y divide-line">
      {incidents.map((i) => (
        <li key={i.id}>
          <button
            onClick={() => onSelect(i.id)}
            aria-current={selected === i.id}
            className={cx(
              "w-full px-4 py-3 text-left transition-colors hover:bg-panel-2",
              selected === i.id && "bg-panel-2 shadow-[inset_2px_0_0_var(--color-dawn)]",
            )}
          >
            <div className="flex items-center gap-2">
              <SeverityDot severity={i.severity} />
              <span className="truncate text-sm font-medium">{i.alertName}</span>
            </div>
            <div className="mt-1.5 flex items-center gap-2 text-xs text-muted">
              <StatusPill incident={i} />
              <span className="font-mono">{i.service}</span>
              <span className="ml-auto shrink-0 text-faint">{ago(i.startedAt, now)}</span>
            </div>
            {i.note && <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted">{i.note.summary}</p>}
          </button>
        </li>
      ))}
    </ul>
  );
}
