import { SpanKind } from "@opentelemetry/api";
import type { Telemetry } from "@firstlook/telemetry";
import pg from "pg";

export type Db = ReturnType<typeof createDb>;

/** A pg pool whose queries are traced and timed as `db.client.operation.duration`. */
export function createDb(tel: Telemetry, connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 20, connectionTimeoutMillis: 3000 });
  const duration = tel.meter.createHistogram("db.client.operation.duration", {
    unit: "s",
    description: "Duration of database operations.",
    advice: { explicitBucketBoundaries: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] },
  });

  /** `operation` is a low-cardinality name like "SELECT bookings.list". */
  async function query<T extends pg.QueryResultRow>(operation: string, sql: string, params: unknown[] = []) {
    const [op = "QUERY", collection = "unknown"] = operation.split(" ");
    const start = process.hrtime.bigint();
    return tel.span(
      operation,
      async (s) => {
        s.setAttribute("db.query.text", sql.replace(/\s+/g, " ").slice(0, 300));
        try {
          return await pool.query<T>(sql, params);
        } finally {
          duration.record(Number(process.hrtime.bigint() - start) / 1e9, {
            "db.system.name": "postgresql",
            "db.operation.name": op,
            "db.collection.name": collection,
          });
        }
      },
      { "db.system.name": "postgresql", "db.operation.name": op, "db.collection.name": collection },
      SpanKind.CLIENT,
    );
  }

  return { pool, query };
}

export async function migrate(db: Db) {
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      worker_id INT NOT NULL,
      client_id INT NOT NULL,
      starts_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmed',
      amount_cents INT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS bookings_worker_idx ON bookings (worker_id, starts_at DESC);

    CREATE TABLE IF NOT EXISTS deploys (
      id SERIAL PRIMARY KEY,
      service TEXT NOT NULL,
      version TEXT NOT NULL,
      commit TEXT NOT NULL,
      description TEXT NOT NULL,
      author TEXT NOT NULL,
      at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS faults (
      scenario TEXT PRIMARY KEY,
      active BOOLEAN NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL
    );
  `);
  const { rows } = await db.pool.query<{ n: string }>("SELECT count(*)::text AS n FROM bookings");
  if (Number(rows[0]?.n ?? 0) === 0) {
    await db.pool.query(`
      INSERT INTO bookings (worker_id, client_id, starts_at, amount_cents, notes)
      SELECT (random() * 400)::int, (random() * 2000)::int,
             now() + (random() * interval '30 days'),
             (3000 + random() * 12000)::int,
             (ARRAY['personal care','community access','overnight support','transport','cleaning'])[1 + (random() * 4)::int]
      FROM generate_series(1, 20000)
    `);
  }
  const deploys = await db.pool.query("SELECT 1 FROM deploys WHERE service = 'demo-api' LIMIT 1");
  if (deploys.rowCount === 0) {
    await db.pool.query(
      `INSERT INTO deploys (service, version, commit, description, author, at)
       VALUES ('demo-api', '1.4.0', 'f3a91c2', 'Add booking reminders', 'deploy-bot', now() - interval '2 days')`,
    );
  }
}
