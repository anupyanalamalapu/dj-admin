import { Pool } from "pg";
import { AdminStore } from "../../types/models";
import { RuntimeStoreAdapter } from "./adapter";
import { EMPTY_STORE, normalizeStore } from "./shared";

const STORE_ROW_KEY = "primary";

type PgClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  release: () => void;
};

let poolPromise: Promise<Pool> | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

export function hasPostgresRuntimeStoreConfig(): boolean {
  return Boolean((process.env.DATABASE_URL || "").trim() || (process.env.POSTGRES_URL || "").trim());
}

function getConnectionString(): string {
  const direct = (process.env.DATABASE_URL || "").trim();
  if (direct) return direct;
  const postgresUrl = (process.env.POSTGRES_URL || "").trim();
  if (postgresUrl) return postgresUrl;
  throw new Error("DATABASE_URL (or POSTGRES_URL) is required for Postgres data storage.");
}

async function getPgPool(): Promise<Pool> {
  if (!poolPromise) {
    poolPromise = Promise.resolve(
      new Pool({
        connectionString: getConnectionString(),
        max: 10,
        idleTimeoutMillis: 30_000,
        ssl: { rejectUnauthorized: false },
      })
    );
  }
  return poolPromise;
}

async function withStorePg<T>(handler: (client: PgClient) => Promise<T>): Promise<T> {
  const pool = await getPgPool();
  const client = await pool.connect();
  try {
    return await handler(client);
  } finally {
    client.release();
  }
}

async function ensurePostgresStoreSchema(client: PgClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS admin_runtime_store (
      key TEXT PRIMARY KEY,
      payload_json JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
  `);
}

export const postgresRuntimeStoreAdapter: RuntimeStoreAdapter = {
  async read(): Promise<AdminStore> {
    return withStorePg(async (client) => {
      await ensurePostgresStoreSchema(client);
      const result = await client.query(
        "SELECT payload_json FROM admin_runtime_store WHERE key = $1 LIMIT 1",
        [STORE_ROW_KEY]
      );
      const row = result.rows[0];
      if (!row) {
        const seeded = structuredClone(EMPTY_STORE);
        await client.query(
          `INSERT INTO admin_runtime_store(key, payload_json, updated_at)
           VALUES ($1, $2::jsonb, $3)
           ON CONFLICT(key) DO UPDATE SET payload_json = EXCLUDED.payload_json, updated_at = EXCLUDED.updated_at`,
          [STORE_ROW_KEY, JSON.stringify(seeded), nowIso()]
        );
        return seeded;
      }

      try {
        const payload = row.payload_json;
        const parsed =
          typeof payload === "string" ? (JSON.parse(payload) as Partial<AdminStore>) : (payload as Partial<AdminStore>);
        return normalizeStore(parsed);
      } catch {
        return structuredClone(EMPTY_STORE);
      }
    });
  },

  async write(store: AdminStore): Promise<void> {
    await withStorePg(async (client) => {
      await ensurePostgresStoreSchema(client);
      await client.query(
        `INSERT INTO admin_runtime_store(key, payload_json, updated_at)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT(key) DO UPDATE SET payload_json = EXCLUDED.payload_json, updated_at = EXCLUDED.updated_at`,
        [STORE_ROW_KEY, JSON.stringify(store), nowIso()]
      );
    });
  },
};
