/**
 * The fault injector. Each scenario is a believable production failure, persisted in Postgres
 * so it survives restarts (a memory leak keeps leaking after the container is OOM-killed).
 *
 * Scenarios that a real team would have caused with a release also write a deploy record,
 * because "what changed?" is the first question an on-call engineer asks.
 */
import { SCENARIOS, type Scenario } from "@firstlook/shared";
import type { Telemetry } from "@firstlook/telemetry";
import type { Db } from "./db.js";

export interface FaultState {
  scenario: Scenario;
  active: boolean;
  startedAt: string;
  endsAt: string;
}

const DURATION_SECONDS: Record<Scenario, number> = {
  "bad-deploy": 360,
  "dependency-outage": 240,
  "memory-leak": 300,
  "noisy-blip": 45,
};

/** Release notes for scenarios that ship as a deploy. */
const RELEASES: Partial<Record<Scenario, { version: string; description: string }>> = {
  "bad-deploy": { version: "1.4.1", description: "Search bookings by notes (#482)" },
  "memory-leak": { version: "1.4.2", description: "Cache worker profiles in memory (#490)" },
};

const BASE_VERSION = "1.4.0";
const randomCommit = () => Math.random().toString(16).slice(2, 9);

export class Faults {
  private active = new Map<Scenario, FaultState>();
  private leak: Buffer[] = [];
  private leakTimer?: NodeJS.Timeout;
  version = BASE_VERSION;

  constructor(
    private db: Db,
    private tel: Telemetry,
    private paymentsUrl: string,
    private adminToken: string,
  ) {}

  isActive(s: Scenario) {
    const f = this.active.get(s);
    return Boolean(f && f.active && Date.parse(f.endsAt) > Date.now());
  }

  list(): FaultState[] {
    return SCENARIOS.map((s) => this.active.get(s) ?? { scenario: s, active: false, startedAt: "", endsAt: "" }).map(
      (f) => ({ ...f, active: this.isActive(f.scenario) }),
    );
  }

  /** Load persisted state and the current version, e.g. after a restart. */
  async load() {
    const { rows } = await this.db.pool.query<{ scenario: Scenario; active: boolean; started_at: Date; ends_at: Date }>(
      "SELECT scenario, active, started_at, ends_at FROM faults",
    );
    for (const r of rows) {
      this.active.set(r.scenario, {
        scenario: r.scenario,
        active: r.active,
        startedAt: r.started_at.toISOString(),
        endsAt: r.ends_at.toISOString(),
      });
    }
    const v = await this.db.pool.query<{ version: string }>(
      "SELECT version FROM deploys WHERE service = 'demo-api' ORDER BY at DESC, id DESC LIMIT 1",
    );
    this.version = v.rows[0]?.version ?? BASE_VERSION;
    if (this.isActive("memory-leak")) this.startLeak();
  }

  async start(s: Scenario) {
    const now = new Date();
    const ends = new Date(now.getTime() + DURATION_SECONDS[s] * 1000);
    await this.db.pool.query(
      `INSERT INTO faults (scenario, active, started_at, ends_at) VALUES ($1, true, $2, $3)
       ON CONFLICT (scenario) DO UPDATE SET active = true, started_at = $2, ends_at = $3`,
      [s, now, ends],
    );
    this.active.set(s, { scenario: s, active: true, startedAt: now.toISOString(), endsAt: ends.toISOString() });

    const release = RELEASES[s];
    if (release) await this.deploy(release.version, release.description);
    if (s === "memory-leak") this.startLeak();
    if (s === "dependency-outage") await this.setPaymentsOutage(true, DURATION_SECONDS[s]);
    // Logged like an ops event, not as a hint for the agent: the agent never sees fault state.
    this.tel.log("info", "admin action", { "admin.action": "scenario.start" });
  }

  async stop(s: Scenario) {
    await this.db.pool.query("UPDATE faults SET active = false WHERE scenario = $1", [s]);
    const f = this.active.get(s);
    if (f) f.active = false;
    if (RELEASES[s] && this.version === RELEASES[s]!.version)
      await this.deploy(BASE_VERSION, `Rollback to ${BASE_VERSION}`);
    if (s === "memory-leak") this.stopLeak();
    if (s === "dependency-outage") await this.setPaymentsOutage(false, 0);
  }

  /** Expire scenarios whose time is up, so the demo heals itself. */
  async sweep() {
    for (const f of this.active.values()) {
      if (f.active && Date.parse(f.endsAt) <= Date.now()) await this.stop(f.scenario);
    }
  }

  private async deploy(version: string, description: string) {
    this.version = version;
    await this.db.pool.query(
      "INSERT INTO deploys (service, version, commit, description, author) VALUES ('demo-api', $1, $2, $3, 'deploy-bot')",
      [version, randomCommit(), description],
    );
    this.tel.log("info", "deployed new version", { "service.version": version, "deploy.description": description });
  }

  private startLeak() {
    if (this.leakTimer) return;
    // Retain ~6 MB a second until the container's memory limit kills the process.
    this.leakTimer = setInterval(() => {
      const chunk = Buffer.alloc(6 * 1024 * 1024, 1);
      this.leak.push(chunk);
    }, 1000);
  }

  private stopLeak() {
    if (this.leakTimer) clearInterval(this.leakTimer);
    this.leakTimer = undefined;
    this.leak = [];
  }

  private async setPaymentsOutage(on: boolean, seconds: number) {
    try {
      await fetch(`${this.paymentsUrl}/admin/outage`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": this.adminToken },
        body: JSON.stringify({ on, seconds }),
        signal: AbortSignal.timeout(3000),
      });
    } catch (err) {
      this.tel.log("warn", "could not reach payments admin", { error: (err as Error).message });
    }
  }
}
