import { Pool, type PoolConfig } from "pg";
import { env } from "./env.js";

/**
 * Direct Postgres connection to Supabase.
 *
 * Why this exists alongside `lib/supabase.ts`:
 * The Supabase JS client speaks PostgREST (HTTP/JSON), which cannot express
 * real aggregation (GROUP BY / FILTER / date_trunc) and forces us to pull
 * every matching row — including large JSONB payloads — over the wire to
 * aggregate in JavaScript. A `pg` client runs the aggregation inside Postgres
 * and returns only the handful of rows we actually need.
 *
 * Serverless notes:
 * - Always connect through Supabase's pooler (transaction mode, port 6543)
 *   rather than the direct IPv6 host, otherwise each concurrent lambda
 *   opens its own socket and exhausts the project connection limit.
 * - `pg` uses unnamed prepared statements, so it is compatible with
 *   PgBouncer in transaction mode.
 * - The pool is a module-level singleton so warm invocations reuse sockets.
 */

let pool: Pool | null = null;
let poolBroken = false;

export function isPgConfigured(): boolean {
  return Boolean(env.DATABASE_URL);
}

export function getPool(): Pool {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  if (poolBroken) throw new Error("Postgres pool is unavailable");
  if (!pool) {
    const config: PoolConfig = {
      connectionString: env.DATABASE_URL,
      // Serverless: keep this small. The pooler multiplexes for us.
      max: Number(process.env.PG_POOL_MAX ?? 2),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      allowExitOnIdle: true,
      // Supabase's pooler presents a cert chain that does not validate
      // against the default CA bundle in some regions.
      ssl: { rejectUnauthorized: false },
      application_name: "fastydiscord",
      options: "-c TimeZone=UTC -c statement_cache_mode=deserialized",
    };
    pool = new Pool(config);
    // An idle client can be killed by the pooler/network at any time.
    // Never let that surface as an unhandled error that kills the function.
    pool.on("error", (err) => {
      poolBroken = true;
      console.error("pg pool error", err instanceof Error ? err.message : String(err));
    });
  }
  return pool;
}

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await getPool().query(text, params as never[]);
  return res.rows as T[];
}

/** Run a query and return the first row (or null). */
export async function queryOne<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows.length ? rows[0] : null;
}
