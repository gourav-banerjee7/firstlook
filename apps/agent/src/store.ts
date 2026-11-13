/**
 * Firstlook's own state in Postgres: incidents, raw alert events, investigation steps, and a
 * job queue (FOR UPDATE SKIP LOCKED, retries with backoff, idempotency keys).
 */
import { randomBytes } from "node:crypto";
import type { Incident, InvestigationStats, InvestigationStep, TriageNote } from "@firstlook/shared";
import pg from "pg";
import type { StepDraft } from "./investigator.js";

export interface ParsedAlert {
  status: "firing" | "resolved";
  alertName: string;
  service: string;
  severity: string;
  summary: string;
  runbook?: string;
  startsAt: Date;
  fingerprint: string;
}

export interface IngestOutcome {
  incidentId?: string;
  action: "created" | "grouped" | "reopened" | "resolved" | "duplicate" | "ignored";
  flapping?: boolean;
}

export interface Job {
  id: number;
  kind: string;
  incident_id: string;
  attempts: number;
}

const REOPEN_WINDOW_MIN = 5;
const GROUP_WINDOW_MIN = 30;
const FLAP_FIRINGS = 3;
const FLAP_WINDOW_MIN = 15;
export const MAX_ATTEMPTS = 3;

export function newIncidentId(now = new Date()): string {
  return `inc_${now.toISOString().slice(0, 10).replace(/-/g, "")}_${randomBytes(3).toString("hex")}`;
}

export class Store {
  readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 });
  }

  async migrate() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS incidents (
        id            text PRIMARY KEY,
        service       text NOT NULL,
        alert_name    text NOT NULL,
        title         text NOT NULL,
        severity      text NOT NULL DEFAULT 'warning',
        status        text NOT NULL DEFAULT 'investigating',
        started_at    timestamptz NOT NULL,
        triaged_at    timestamptz,
        resolved_at   timestamptz,
        active_alerts text[] NOT NULL DEFAULT '{}',
        all_alerts    text[] NOT NULL DEFAULT '{}',
        alert_count   int NOT NULL DEFAULT 1,
        flapping      boolean NOT NULL DEFAULT false,
        summary       text NOT NULL DEFAULT '',
        runbook_url   text,
        note          jsonb,
        stats         jsonb,
        feedback      jsonb,
        created_at    timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE incidents ADD COLUMN IF NOT EXISTS feedback jsonb;
      CREATE INDEX IF NOT EXISTS incidents_open ON incidents (service) WHERE status <> 'resolved';
      CREATE INDEX IF NOT EXISTS incidents_recent ON incidents (created_at DESC);

      CREATE TABLE IF NOT EXISTS alert_events (
        id          bigserial PRIMARY KEY,
        dedupe_key  text NOT NULL UNIQUE,
        incident_id text REFERENCES incidents(id),
        service     text NOT NULL,
        alert_name  text NOT NULL,
        status      text NOT NULL,
        starts_at   timestamptz NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS alert_events_flap ON alert_events (service, alert_name, received_at);

      CREATE TABLE IF NOT EXISTS steps (
        incident_id text NOT NULL REFERENCES incidents(id),
        seq         int NOT NULL,
        at          timestamptz NOT NULL DEFAULT now(),
        kind        text NOT NULL,
        tool        text,
        title       text NOT NULL,
        detail      text,
        query       text,
        url         text,
        result      jsonb,
        PRIMARY KEY (incident_id, seq)
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id              bigserial PRIMARY KEY,
        kind            text NOT NULL,
        incident_id     text NOT NULL REFERENCES incidents(id),
        idempotency_key text NOT NULL UNIQUE,
        status          text NOT NULL DEFAULT 'queued',
        attempts        int NOT NULL DEFAULT 0,
        run_after       timestamptz NOT NULL DEFAULT now(),
        locked_at       timestamptz,
        last_error      text,
        created_at      timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS jobs_ready ON jobs (run_after) WHERE status = 'queued';
    `);
  }

  // ---- ingest ------------------------------------------------------------------------------

  /**
   * Record one alert and decide what it means, in one transaction:
   * duplicate → ignore; firing → new incident, or group into an open incident on the same service,
   * or reopen one resolved minutes ago (flap detection); resolved → clear it from its incident.
   */
  async ingest(a: ParsedAlert, investigateDelayMs: number): Promise<IngestOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Serialise ingest per service so two alerts can't both create an incident.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [a.service]);

      const dedupeKey = `${a.fingerprint}:${a.status}:${a.startsAt.toISOString()}`;
      const ins = await client.query<{ id: string }>(
        `INSERT INTO alert_events (dedupe_key, service, alert_name, status, starts_at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
        [dedupeKey, a.service, a.alertName, a.status, a.startsAt],
      );
      if (!ins.rowCount) {
        await client.query("COMMIT");
        return { action: "duplicate" };
      }
      const eventId = ins.rows[0]!.id;
      const outcome =
        a.status === "firing" ? await this.onFiring(client, a, investigateDelayMs) : await this.onResolved(client, a);
      if (outcome.incidentId)
        await client.query("UPDATE alert_events SET incident_id = $1 WHERE id = $2", [outcome.incidentId, eventId]);
      await client.query("COMMIT");
      return outcome;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  private async onFiring(c: pg.PoolClient, a: ParsedAlert, delayMs: number): Promise<IngestOutcome> {
    const open = await c.query<{ id: string; active_alerts: string[]; all_alerts: string[] }>(
      `SELECT id, active_alerts, all_alerts FROM incidents
       WHERE service = $1 AND status <> 'resolved' AND started_at > now() - make_interval(mins => $2)
       ORDER BY started_at DESC LIMIT 1 FOR UPDATE`,
      [a.service, GROUP_WINDOW_MIN],
    );
    if (open.rows[0]) {
      const inc = open.rows[0];
      const isNew = !inc.all_alerts.includes(a.alertName);
      await c.query(
        `UPDATE incidents SET alert_count = alert_count + 1,
           active_alerts = (SELECT array_agg(DISTINCT x) FROM unnest(active_alerts || $2::text) x),
           all_alerts    = (SELECT array_agg(DISTINCT x) FROM unnest(all_alerts || $2::text) x)
         WHERE id = $1`,
        [inc.id, a.alertName],
      );
      if (isNew)
        await this.addStepTx(c, inc.id, {
          kind: "update",
          title: `Related alert joined: ${a.alertName}`,
          detail: a.summary,
        });
      return { incidentId: inc.id, action: "grouped", flapping: await this.checkFlap(c, inc.id, a) };
    }

    const recent = await c.query<{ id: string; note: unknown; resolved_at: Date }>(
      `SELECT id, note, resolved_at FROM incidents
       WHERE service = $1 AND status = 'resolved' AND $2 = ANY(all_alerts) AND resolved_at > now() - make_interval(mins => $3)
       ORDER BY resolved_at DESC LIMIT 1 FOR UPDATE`,
      [a.service, a.alertName, REOPEN_WINDOW_MIN],
    );
    if (recent.rows[0]) {
      const inc = recent.rows[0];
      await c.query(
        `UPDATE incidents SET status = CASE WHEN note IS NULL THEN 'investigating' ELSE 'triaged' END, resolved_at = NULL,
           alert_count = alert_count + 1, active_alerts = ARRAY[$2::text] WHERE id = $1`,
        [inc.id, a.alertName],
      );
      const mins = Math.max(1, Math.round((Date.now() - inc.resolved_at.getTime()) / 60_000));
      await this.addStepTx(c, inc.id, {
        kind: "update",
        title: `Fired again ${mins} min after resolving`,
        detail: a.summary,
      });
      // Re-check what's going on, unless it's flapping (then re-investigating each time is just noise).
      const flapping = await this.checkFlap(c, inc.id, a);
      if (!flapping) {
        await c.query("UPDATE incidents SET status = 'investigating' WHERE id = $1", [inc.id]);
        await c.query(
          `INSERT INTO jobs (kind, incident_id, idempotency_key, run_after) VALUES ('investigate', $1, $2, now() + make_interval(secs => $3))
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [inc.id, `investigate:${inc.id}:${a.startsAt.toISOString()}`, delayMs / 1000],
        );
      }
      return { incidentId: inc.id, action: "reopened", flapping };
    }

    const id = newIncidentId();
    await c.query(
      `INSERT INTO incidents (id, service, alert_name, title, severity, started_at, active_alerts, all_alerts, summary, runbook_url)
       VALUES ($1,$2,$3,$4,$5,$6,ARRAY[$3],ARRAY[$3],$7,$8)`,
      [
        id,
        a.service,
        a.alertName,
        `${a.alertName} on ${a.service}`,
        a.severity,
        a.startsAt,
        a.summary,
        a.runbook ?? null,
      ],
    );
    await this.addStepTx(c, id, { kind: "update", title: `Alert fired: ${a.alertName}`, detail: a.summary });
    await c.query(
      `INSERT INTO jobs (kind, incident_id, idempotency_key, run_after) VALUES ('investigate', $1, $2, now() + make_interval(secs => $3))
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [id, `investigate:${id}`, delayMs / 1000],
    );
    return { incidentId: id, action: "created" };
  }

  private async checkFlap(c: pg.PoolClient, incidentId: string, a: ParsedAlert): Promise<boolean> {
    const { rows } = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM alert_events
       WHERE service = $1 AND alert_name = $2 AND status = 'firing' AND received_at > now() - make_interval(mins => $3)`,
      [a.service, a.alertName, FLAP_WINDOW_MIN],
    );
    if ((rows[0]?.n ?? 0) < FLAP_FIRINGS) return false;
    const upd = await c.query("UPDATE incidents SET flapping = true WHERE id = $1 AND NOT flapping", [incidentId]);
    if (upd.rowCount) {
      await this.addStepTx(c, incidentId, {
        kind: "update",
        title: "Alert is flapping",
        detail: `${a.alertName} fired ${rows[0]!.n} times in ${FLAP_WINDOW_MIN} min. Not re-investigating each time; consider a longer pending period.`,
      });
    }
    return true;
  }

  private async onResolved(c: pg.PoolClient, a: ParsedAlert): Promise<IngestOutcome> {
    const { rows } = await c.query<{ id: string; active_alerts: string[] }>(
      `SELECT id, active_alerts FROM incidents WHERE service = $1 AND status <> 'resolved' AND $2 = ANY(active_alerts)
       ORDER BY started_at DESC LIMIT 1 FOR UPDATE`,
      [a.service, a.alertName],
    );
    const inc = rows[0];
    if (!inc) return { action: "ignored" };
    const remaining = inc.active_alerts.filter((x) => x !== a.alertName);
    await c.query(
      `UPDATE incidents SET active_alerts = $2, status = CASE WHEN cardinality($2::text[]) = 0 THEN 'resolved' ELSE status END,
         resolved_at = CASE WHEN cardinality($2::text[]) = 0 THEN now() ELSE resolved_at END WHERE id = $1`,
      [inc.id, remaining],
    );
    await this.addStepTx(c, inc.id, {
      kind: "update",
      title: remaining.length ? `${a.alertName} resolved` : "All alerts resolved",
      detail: remaining.length
        ? `Still firing: ${remaining.join(", ")}`
        : "Grafana reports the incident's alerts as resolved.",
    });
    return { incidentId: inc.id, action: "resolved" };
  }

  // ---- steps ---------------------------------------------------------------------------------

  private async addStepTx(c: pg.PoolClient | pg.Pool, incidentId: string, s: StepDraft) {
    await c.query(
      `INSERT INTO steps (incident_id, seq, kind, tool, title, detail, query, url, result)
       VALUES ($1, (SELECT coalesce(max(seq), 0) + 1 FROM steps WHERE incident_id = $1), $2,$3,$4,$5,$6,$7,$8)`,
      [
        incidentId,
        s.kind,
        s.tool ?? null,
        s.title,
        s.detail ?? null,
        s.query ?? null,
        s.url ?? null,
        s.result === undefined ? null : JSON.stringify(s.result),
      ],
    );
  }

  async addStep(incidentId: string, s: StepDraft) {
    // Steps for one incident are written by one worker, but the webhook can add some too; retry on the rare seq clash.
    for (let i = 0; i < 3; i++) {
      try {
        return await this.addStepTx(this.pool, incidentId, s);
      } catch (err) {
        if ((err as { code?: string }).code !== "23505" || i === 2) throw err;
      }
    }
  }

  async steps(incidentId: string, afterSeq = 0): Promise<InvestigationStep[]> {
    const { rows } = await this.pool.query(
      `SELECT seq, at, kind, tool, title, detail, query, url, result FROM steps WHERE incident_id = $1 AND seq > $2 ORDER BY seq`,
      [incidentId, afterSeq],
    );
    return rows.map((r) => ({
      id: `${incidentId}:${r.seq}`,
      incidentId,
      at: (r.at as Date).toISOString(),
      kind: r.kind,
      title: r.title,
      ...(r.tool ? { tool: r.tool } : {}),
      ...(r.detail ? { detail: r.detail } : {}),
      ...(r.query ? { query: r.query } : {}),
      ...(r.url ? { url: r.url } : {}),
      ...(r.result !== null ? { result: r.result } : {}),
    }));
  }

  // ---- incidents -----------------------------------------------------------------------------

  private toIncident(r: Record<string, unknown>): Incident {
    const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : undefined);
    return {
      id: r.id as string,
      title: r.title as string,
      service: r.service as string,
      alertName: r.alert_name as string,
      status: r.status as Incident["status"],
      startedAt: iso(r.started_at)!,
      ...(r.triaged_at ? { triagedAt: iso(r.triaged_at)! } : {}),
      ...(r.resolved_at ? { resolvedAt: iso(r.resolved_at)! } : {}),
      ...(r.note ? { note: r.note as TriageNote } : {}),
      severity: r.severity as string,
      alerts: r.all_alerts as string[],
      flapping: r.flapping as boolean,
      ...(r.stats ? { investigation: r.stats as InvestigationStats } : {}),
    };
  }

  async incidents(limit = 50): Promise<Incident[]> {
    const { rows } = await this.pool.query("SELECT * FROM incidents ORDER BY started_at DESC LIMIT $1", [limit]);
    return rows.map((r) => this.toIncident(r));
  }

  async incident(id: string): Promise<(Incident & { summary: string; runbookUrl?: string }) | undefined> {
    const { rows } = await this.pool.query("SELECT * FROM incidents WHERE id = $1", [id]);
    const r = rows[0];
    if (!r) return undefined;
    return { ...this.toIncident(r), summary: r.summary, ...(r.runbook_url ? { runbookUrl: r.runbook_url } : {}) };
  }

  async saveNote(id: string, note: TriageNote, stats: InvestigationStats) {
    await this.pool.query(
      `UPDATE incidents SET note = $2, stats = $3, triaged_at = now(),
         status = CASE WHEN status = 'resolved' THEN status ELSE 'triaged' END WHERE id = $1`,
      [id, JSON.stringify(note), JSON.stringify(stats)],
    );
  }

  async saveFeedback(id: string, helpful: boolean) {
    const r = await this.pool.query("UPDATE incidents SET feedback = $2 WHERE id = $1 AND note IS NOT NULL", [
      id,
      JSON.stringify({ helpful, at: new Date().toISOString() }),
    ]);
    return (r.rowCount ?? 0) > 0;
  }

  // ---- queue ---------------------------------------------------------------------------------

  async enqueue(kind: string, incidentId: string, key: string, delayMs = 0) {
    const r = await this.pool.query(
      `INSERT INTO jobs (kind, incident_id, idempotency_key, run_after) VALUES ($1,$2,$3, now() + make_interval(secs => $4))
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [kind, incidentId, key, delayMs / 1000],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async claim(): Promise<Job | undefined> {
    const { rows } = await this.pool.query<Job>(
      `UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
       WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_after <= now() ORDER BY run_after, id FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id, kind, incident_id, attempts`,
    );
    return rows[0];
  }

  async complete(jobId: number) {
    await this.pool.query("UPDATE jobs SET status = 'done', locked_at = NULL WHERE id = $1", [jobId]);
  }

  /** Retry with exponential backoff (10 s, 40 s), then give up. */
  async fail(job: Job, error: string): Promise<"retry" | "failed"> {
    const retry = job.attempts < MAX_ATTEMPTS;
    await this.pool.query(
      `UPDATE jobs SET status = $2, locked_at = NULL, last_error = $3, run_after = now() + make_interval(secs => $4) WHERE id = $1`,
      [job.id, retry ? "queued" : "failed", error.slice(0, 500), 10 * 4 ** (job.attempts - 1)],
    );
    return retry ? "retry" : "failed";
  }

  /** Jobs whose worker died mid-run go back on the queue. */
  async requeueStale(minutes = 5) {
    await this.pool.query(
      `UPDATE jobs SET status = 'queued', locked_at = NULL WHERE status = 'running' AND locked_at < now() - make_interval(mins => $1)`,
      [minutes],
    );
  }
}
