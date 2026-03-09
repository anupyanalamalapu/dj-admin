import fs from "fs/promises";
import path from "path";
import { Pool } from "pg";
import { AdminStore } from "../types/models";
import { getClientsDir, getContractsDir, getStorePath, getUploadsDir } from "./paths";

const EMPTY_STORE: AdminStore = {
  adminProfile: {
    baseHourlyRate: 600,
    ownerName: "Anupya Nalamalapu",
    ownerEmail: "djanupya@gmail.com",
    ownerPhone: "+1 408 887 2397",
    ownerInstagramHandle: "@djanupya",
  },
  clients: [],
  inquiries: [],
  events: [],
  contracts: [],
  invoices: [],
  documents: [],
  communications: [],
  trainingExamples: [],
};

const STORE_ROW_KEY = "primary";

type PgClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  release: () => void;
};

let poolPromise: Promise<Pool> | null = null;

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

function nowIso(): string {
  return new Date().toISOString();
}

function hasPostgresStoreConfig(): boolean {
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

function normalizeStore(parsed?: Partial<AdminStore>): AdminStore {
  const data = parsed || {};
  return {
    adminProfile: {
      baseHourlyRate:
        typeof data.adminProfile?.baseHourlyRate === "number" && Number.isFinite(data.adminProfile.baseHourlyRate)
          ? data.adminProfile.baseHourlyRate
          : 600,
      ownerName:
        typeof data.adminProfile?.ownerName === "string" && data.adminProfile.ownerName.trim()
          ? data.adminProfile.ownerName.trim()
          : "Anupya Nalamalapu",
      ownerEmail:
        typeof data.adminProfile?.ownerEmail === "string" && data.adminProfile.ownerEmail.trim()
          ? data.adminProfile.ownerEmail.trim().toLowerCase()
          : "djanupya@gmail.com",
      ownerPhone:
        typeof data.adminProfile?.ownerPhone === "string" && data.adminProfile.ownerPhone.trim()
          ? data.adminProfile.ownerPhone.trim()
          : "+1 408 887 2397",
      ownerInstagramHandle:
        typeof data.adminProfile?.ownerInstagramHandle === "string" && data.adminProfile.ownerInstagramHandle.trim()
          ? data.adminProfile.ownerInstagramHandle.trim()
          : "@djanupya",
    },
    clients: Array.isArray(data.clients) ? data.clients : [],
    inquiries: Array.isArray(data.inquiries) ? data.inquiries : [],
    events: Array.isArray(data.events) ? data.events : [],
    contracts: Array.isArray(data.contracts) ? data.contracts : [],
    invoices: Array.isArray(data.invoices) ? data.invoices : [],
    documents: Array.isArray(data.documents) ? data.documents : [],
    communications: Array.isArray(data.communications) ? data.communications : [],
    trainingExamples: Array.isArray(data.trainingExamples) ? data.trainingExamples : [],
  };
}

export async function ensureAdminDataLayout(): Promise<void> {
  const storePath = getStorePath();
  await ensureDir(path.dirname(storePath));
  await ensureDir(getClientsDir());
  await ensureDir(getUploadsDir());
  await ensureDir(getContractsDir());
  await ensureDir(path.join(getContractsDir(), "generated"));
  await ensureDir(path.join(getContractsDir(), "examples"));

  try {
    await fs.access(storePath);
  } catch {
    await fs.writeFile(storePath, JSON.stringify(EMPTY_STORE, null, 2), "utf8");
  }
}

export async function readStore(): Promise<AdminStore> {
  await ensureAdminDataLayout();
  if (hasPostgresStoreConfig()) {
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
  }

  const storePath = getStorePath();
  const raw = await fs.readFile(storePath, "utf8");
  if (!raw.trim()) {
    return structuredClone(EMPTY_STORE);
  }
  try {
    return normalizeStore(JSON.parse(raw) as Partial<AdminStore>);
  } catch {
    return structuredClone(EMPTY_STORE);
  }
}

export async function writeStore(store: AdminStore): Promise<void> {
  await ensureAdminDataLayout();
  if (hasPostgresStoreConfig()) {
    await withStorePg(async (client) => {
      await ensurePostgresStoreSchema(client);
      await client.query(
        `INSERT INTO admin_runtime_store(key, payload_json, updated_at)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT(key) DO UPDATE SET payload_json = EXCLUDED.payload_json, updated_at = EXCLUDED.updated_at`,
        [STORE_ROW_KEY, JSON.stringify(store), nowIso()]
      );
    });
    return;
  }

  const storePath = getStorePath();
  const tempPath = `${storePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tempPath, storePath);
}
