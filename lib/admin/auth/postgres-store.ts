import fs from "fs";
import { Pool } from "pg";
import { createId } from "../utils/id";
import { getAuthStorePath } from "../persistence/paths";

type PgClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  release: () => void;
};

interface LegacyAuthUserRecord {
  id?: string;
  username?: string;
  passwordHash?: string;
  role?: string;
  isActive?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

interface LegacyAuthSessionRecord {
  id?: string;
  userId?: string;
  tokenHash?: string;
  createdAt?: string;
  expiresAt?: string;
  lastSeenAt?: string;
  ip?: string;
  userAgent?: string;
}

interface LegacyRateLimitRecord {
  id?: string;
  key?: string;
  windowStartMs?: number;
  attempts?: number;
  lockUntilMs?: number | null;
  lastAttemptAtMs?: number;
}

interface LegacyAuthStore {
  users?: LegacyAuthUserRecord[];
  sessions?: LegacyAuthSessionRecord[];
  rateLimits?: LegacyRateLimitRecord[];
}

const LEGACY_MIGRATION_KEY = "legacy_json_auth_migrated_v1";

let poolPromise: Promise<Pool> | null = null;
let initPromise: Promise<void> | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeIso(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return fallback;
  return new Date(parsed).toISOString();
}

function normalizeMs(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  return fallback;
}

function getConnectionString(): string {
  const direct = (process.env.DATABASE_URL || "").trim();
  if (direct) return direct;
  const postgresUrl = (process.env.POSTGRES_URL || "").trim();
  if (postgresUrl) return postgresUrl;
  throw new Error("DATABASE_URL (or POSTGRES_URL) is required for Postgres auth storage.");
}

export function hasPostgresConfig(): boolean {
  return Boolean((process.env.DATABASE_URL || "").trim() || (process.env.POSTGRES_URL || "").trim());
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

async function parseLegacyAuthStore(): Promise<LegacyAuthStore | null> {
  const legacyPath = getAuthStorePath();
  if (!fs.existsSync(legacyPath)) return null;
  try {
    const raw = await fs.promises.readFile(legacyPath, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw) as LegacyAuthStore;
  } catch {
    return null;
  }
}

async function backupLegacyAuthStore(): Promise<string | null> {
  const legacyPath = getAuthStorePath();
  if (!fs.existsSync(legacyPath)) return null;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${legacyPath}.backup-${timestamp}.json`;
  await fs.promises.copyFile(legacyPath, backupPath);
  return backupPath;
}

async function initSchemaAndMigrate(client: PgClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL,
      ip TEXT,
      user_agent TEXT
    );
  `);
  await client.query("CREATE INDEX IF NOT EXISTS idx_admin_sessions_user_id ON admin_sessions(user_id);");
  await client.query("CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at ON admin_sessions(expires_at);");
  await client.query(`
    CREATE TABLE IF NOT EXISTS admin_login_attempts (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      window_start_ms BIGINT NOT NULL,
      attempts INTEGER NOT NULL,
      lock_until_ms BIGINT,
      last_attempt_at_ms BIGINT NOT NULL
    );
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      username TEXT,
      ip TEXT,
      details_json TEXT,
      created_at TIMESTAMPTZ NOT NULL
    );
  `);
  await client.query("CREATE INDEX IF NOT EXISTS idx_admin_audit_created_at ON admin_audit_log(created_at);");
  await client.query(`
    CREATE TABLE IF NOT EXISTS admin_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
  `);

  const migratedRow = await client.query("SELECT value FROM admin_meta WHERE key = $1 LIMIT 1", [LEGACY_MIGRATION_KEY]);
  if ((migratedRow.rows[0]?.value as string | undefined) === "1") {
    return;
  }

  const legacyPath = getAuthStorePath();
  if (!fs.existsSync(legacyPath)) {
    await client.query(
      `INSERT INTO admin_meta(key, value, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [LEGACY_MIGRATION_KEY, "1", nowIso()]
    );
    return;
  }

  const backupPath = await backupLegacyAuthStore();
  const legacy = await parseLegacyAuthStore();
  if (!legacy) {
    await client.query(
      `INSERT INTO admin_meta(key, value, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [LEGACY_MIGRATION_KEY, "1", nowIso()]
    );
    if (backupPath) {
      await client.query(
        `INSERT INTO admin_meta(key, value, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [`${LEGACY_MIGRATION_KEY}_backup_path`, backupPath, nowIso()]
      );
    }
    return;
  }

  const nowMs = Date.now();
  const nowStamp = nowIso();

  await client.query("BEGIN");
  try {
    for (const user of Array.isArray(legacy.users) ? legacy.users : []) {
      const username = (user.username || "").trim().toLowerCase();
      const passwordHash = (user.passwordHash || "").trim();
      if (!username || !passwordHash) continue;
      await client.query(
        `INSERT INTO admin_users (id, username, password_hash, role, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (username) DO NOTHING`,
        [
          (user.id || createId("admin_user")).trim(),
          username,
          passwordHash,
          (user.role || "admin").trim() || "admin",
          user.isActive === false ? false : true,
          normalizeIso(user.createdAt, nowStamp),
          normalizeIso(user.updatedAt, nowStamp),
        ]
      );
    }

    for (const session of Array.isArray(legacy.sessions) ? legacy.sessions : []) {
      const userId = (session.userId || "").trim();
      const tokenHash = (session.tokenHash || "").trim();
      if (!userId || !tokenHash) continue;
      await client.query(
        `INSERT INTO admin_sessions
          (id, user_id, token_hash, created_at, expires_at, last_seen_at, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (token_hash) DO NOTHING`,
        [
          (session.id || createId("admin_session")).trim(),
          userId,
          tokenHash,
          normalizeIso(session.createdAt, nowStamp),
          normalizeIso(session.expiresAt, nowStamp),
          normalizeIso(session.lastSeenAt, nowStamp),
          (session.ip || "").slice(0, 255),
          (session.userAgent || "").slice(0, 500),
        ]
      );
    }

    for (const attempt of Array.isArray(legacy.rateLimits) ? legacy.rateLimits : []) {
      const key = (attempt.key || "").trim();
      if (!key) continue;
      const lockUntil = normalizeMs(attempt.lockUntilMs, 0);
      await client.query(
        `INSERT INTO admin_login_attempts
          (id, key, window_start_ms, attempts, lock_until_ms, last_attempt_at_ms)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (key) DO UPDATE SET
           window_start_ms = EXCLUDED.window_start_ms,
           attempts = EXCLUDED.attempts,
           lock_until_ms = EXCLUDED.lock_until_ms,
           last_attempt_at_ms = EXCLUDED.last_attempt_at_ms`,
        [
          (attempt.id || createId("admin_rl")).trim(),
          key,
          normalizeMs(attempt.windowStartMs, nowMs),
          Math.max(0, normalizeMs(attempt.attempts, 0)),
          lockUntil > 0 ? lockUntil : null,
          normalizeMs(attempt.lastAttemptAtMs, nowMs),
        ]
      );
    }

    await client.query(
      `INSERT INTO admin_meta(key, value, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [LEGACY_MIGRATION_KEY, "1", nowIso()]
    );
    if (backupPath) {
      await client.query(
        `INSERT INTO admin_meta(key, value, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [`${LEGACY_MIGRATION_KEY}_backup_path`, backupPath, nowIso()]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function ensureInitialized(client: PgClient): Promise<void> {
  if (!initPromise) {
    initPromise = initSchemaAndMigrate(client);
  }
  await initPromise;
}

export async function withPostgresClient<T>(handler: (client: PgClient) => Promise<T>): Promise<T> {
  const pool = await getPgPool();
  const client = await pool.connect();
  try {
    await ensureInitialized(client);
    return await handler(client);
  } finally {
    client.release();
  }
}
