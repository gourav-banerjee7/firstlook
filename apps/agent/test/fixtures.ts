/**
 * Fake telemetry for the four demo scenarios, shaped like what Prometheus, Loki, Tempo and the
 * deploy log return during each one. Lets the whole investigation run in a unit test.
 */
import type { Scenario } from "@firstlook/shared";
import type { Deploy, LogLine, Series, Sources, SpanInfo, TraceHit } from "../src/sources.js";

export interface Fixture {
  sources: Sources;
  onset: Date;
  alertName: string;
}

const STEP = 15;

function series(now: number, f: (secondsFromOnset: number) => number, onsetS: number): Series["points"] {
  const pts: Array<[number, number]> = [];
  for (let t = onsetS - 20 * 60; t <= now; t += STEP) pts.push([t, f(t - onsetS)]);
  return pts;
}

export function fixture(scenario: Scenario, opts: { injectLog?: string } = {}): Fixture {
  const nowS = Math.floor(Date.now() / 1000);
  const onsetS = nowS - 180;
  const onset = new Date(onsetS * 1000);
  const at = (secondsFromOnset: number) => new Date((onsetS + secondsFromOnset) * 1000).toISOString();

  const latency = (x: number) => (scenario === "bad-deploy" && x >= -60 ? 0.95 : 0.04);
  const errRate = (x: number) =>
    scenario === "dependency-outage" && x >= -45
      ? 0.17
      : scenario === "noisy-blip" && x >= -30 && x <= 15
        ? 0.35
        : 0.002;
  const memory = (x: number) => (scenario === "memory-leak" && x >= -80 ? 70e6 + (x + 80) * 1.05e6 : 70e6);
  const depErr = (x: number) => (scenario === "dependency-outage" && x >= -45 ? 0.88 : 0);
  const depLat = (x: number) => (scenario === "dependency-outage" && x >= -45 ? 2.41 : 0.12);

  const deploys: Deploy[] = [
    {
      service: "demo-api",
      version: "1.4.0",
      commit: "f3a91c2",
      description: "Add booking reminders",
      author: "priya",
      at: at(-3 * 3600),
    },
  ];
  if (scenario === "bad-deploy")
    deploys.unshift({
      service: "demo-api",
      version: "1.4.1",
      commit: "9b1e7d0",
      description: "Search bookings by notes (#482)",
      author: "sam",
      at: at(-420),
    });
  if (scenario === "memory-leak")
    deploys.unshift({
      service: "demo-api",
      version: "1.4.2",
      commit: "c44a0e1",
      description: "Cache worker profiles in memory (#490)",
      author: "sam",
      at: at(-120),
    });

  const logLines: LogLine[] = [];
  const add = (
    n: number,
    from: number,
    to: number,
    line: string,
    level: string,
    labels: Record<string, string> = {},
  ) => {
    for (let i = 0; i < n; i++)
      logLines.push({
        at: (onsetS + from + ((to - from) * i) / n) * 1000,
        line,
        labels: { severity_text: level, service_version: "1.4.0", ...labels },
      });
  };
  add(3, -600, -200, "upstream connection reset", "ERROR");
  if (scenario === "bad-deploy")
    add(150, -60, 170, "slow query", "WARN", { db_operation_name: "SELECT bookings.search" });
  if (scenario === "dependency-outage")
    add(90, -45, 170, "payment charge failed", "ERROR", { server_address: "payments-stub" });
  if (scenario === "noisy-blip") add(60, -30, 15, "upstream connection reset", "ERROR", { error_type: "ECONNRESET" });
  if (opts.injectLog) add(5, 0, 60, opts.injectLog, "ERROR");

  const sources: Sources = {
    async promRange(expr) {
      const one = (f: (x: number) => number, labels: Record<string, string> = {}): Series => ({
        labels,
        points: series(nowS, f, onsetS),
      });
      if (expr.includes("process_memory")) return [one(memory)];
      if (expr.includes("http_client")) {
        return expr.includes("histogram_quantile")
          ? [one(depLat, { server_address: "payments-stub" })]
          : [one(depErr, { server_address: "payments-stub" })];
      }
      const byRoute = expr.includes("by (le, http_route)") || expr.includes("by (http_route)");
      if (expr.includes("histogram_quantile")) {
        return byRoute
          ? [one(latency, { http_route: "/bookings" }), one(() => 0.03, { http_route: "/deploys" })]
          : [one(latency)];
      }
      if (expr.includes('"5.."')) return [one(errRate)];
      return [one(() => 12)];
    },
    async logs() {
      return [...logLines].sort((a, b) => b.at - a.at);
    },
    async traces(): Promise<TraceHit[]> {
      if (scenario !== "bad-deploy") return [];
      return Array.from({ length: 14 }, (_, i) => ({
        traceId: `t${i}`,
        rootName: "GET /bookings",
        rootService: "demo-api",
        durationMs: 700 + i * 23,
        startMs: (onsetS + i * 10) * 1000,
      }));
    },
    async traceSpans(): Promise<SpanInfo[]> {
      return [
        { name: "GET /bookings", service: "demo-api", durationMs: 1000, parent: true },
        { name: "SELECT bookings.search", service: "demo-api", durationMs: 970, parent: false },
      ];
    },
    async deploys(since) {
      return deploys.filter((d) => new Date(d.at) >= since);
    },
  };

  const alertName =
    scenario === "bad-deploy"
      ? "High P99 latency"
      : scenario === "memory-leak"
        ? "Memory near limit"
        : "High 5xx error rate";
  return { sources, onset, alertName };
}
