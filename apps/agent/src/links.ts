/**
 * Grafana Explore deep links. Every piece of evidence carries one, so a human can reproduce
 * exactly what the agent saw with a single click.
 */
export type Datasource = "prometheus" | "loki" | "tempo";

export interface Range {
  from: Date;
  to: Date;
}

export function exploreUrl(grafanaUrl: string, ds: Datasource, query: string, range: Range): string {
  const q =
    ds === "tempo"
      ? { refId: "A", datasource: { type: ds, uid: ds }, queryType: "traceql", query }
      : { refId: "A", datasource: { type: ds, uid: ds }, expr: query };
  const panes = {
    a: {
      datasource: ds,
      queries: [q],
      range: { from: String(range.from.getTime()), to: String(range.to.getTime()) },
    },
  };
  return `${grafanaUrl.replace(/\/$/, "")}/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(JSON.stringify(panes))}`;
}

export function traceUrl(grafanaUrl: string, traceId: string, range: Range): string {
  return exploreUrl(grafanaUrl, "tempo", traceId, range);
}
