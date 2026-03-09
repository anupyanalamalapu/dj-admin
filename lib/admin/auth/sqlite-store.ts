import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { createId } from "../utils/id";
import { getAuthDbPath, getAuthStorePath } from "../persistence/paths";

type SqliteDb = {
  exec: (sql: string) => void;
  prepare: (sql: string) => {
    get: (...params: unknown[]) => Record<string, unknown> | undefined;
    all: (...params: unknown[]) => Array<Record<string, unknown>>;
    run: (...params: unknown[]) => Record<string, unknown>;
  };
  close: () => void;
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
  lockUntilMs?: number;
  lastAttemptAtMs?: number;
}

interface LegacyAuthStore {
  users?: LegacyAuthUserRecord[];
  sessions?: LegacyAuthSessionRecord[];
  rateLimits?: LegacyRateLimitRecord[];
}

const LEGACY_MIGRATION_KEY = "legacy_json_auth_migrated_v1";

function nowIso(): string {
  return new Date().toISOString();
}

function ensureAuthDbDirectory(): void {
  fs.mkdirSync(path.dirname(getAuthDbPath()), { recursive: true });
}

function initializeSchema(db: SqliteDb): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT,
      FOREIGN KEY(user_id) REFERENCES admin_users(id) ON DELETE CASCADE
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_admin_sessions_user_id ON admin_sessions(user_id);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at ON admin_sessions(expires_at);");
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_login_attempts (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      window_start_ms INTEGER NOT NULL,
      attempts INTEGER NOT NULL,
      lock_until_ms INTEGER,
      last_attempt_at_ms INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      username TEXT,
      ip TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_admin_audit_created_at ON admin_audit_log(created_at);");
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function getMetaValue(db: SqliteDb, key: string): string | null {
  const row = db.prepare("SELECT value FROM admin_meta WHERE key = ?").get(key);
  if (!row || typeof row.value !== "string") return null;
  return row.value;
}

function setMetaValue(db: SqliteDb, key: string, value: string): void {
  db.prepare(
    `INSERT INTO admin_meta(key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, nowIso());
}

function parseLegacyAuthStore(): LegacyAuthStore | null {
  const legacyPath = getAuthStorePath();
  if (!fs.existsSync(legacyPath)) return null;
  try {
    const raw = fs.readFileSync(legacyPath, "utf8");
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw) as LegacyAuthStore;
    return parsed;
  } catch {
    return null;
  }
}

function backupLegacyAuthStore(): string | null {
  const legacyPath = getAuthStorePath();
  if (!fs.existsSync(legacyPath)) return null;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${legacyPath}.backup-${timestamp}.json`;
  fs.copyFileSync(legacyPath, backupPath);
  return backupPath;
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

function runLegacyJsonMigration(db: SqliteDb): void {
  if (getMetaValue(db, LEGACY_MIGRATION_KEY) === "1") {
    return;
  }

  const legacyPath = getAuthStorePath();
  if (!fs.existsSync(legacyPath)) {
    setMetaValue(db, LEGACY_MIGRATION_KEY, "1");
    return;
  }

  const backupPath = backupLegacyAuthStore();
  const legacy = parseLegacyAuthStore();
  if (!legacy) {
    setMetaValue(db, LEGACY_MIGRATION_KEY, "1");
    if (backupPath) {
      setMetaValue(db, `${LEGACY_MIGRATION_KEY}_backup_path`, backupPath);
    }
    return;
  }

  const now = Date.now();
  const nowStamp = nowIso();

  const insertUser = db.prepare(
    `INSERT OR IGNORE INTO admin_users
      (id, username, password_hash, role, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insertSession = db.prepare(
    `INSERT OR IGNORE INTO admin_sessions
      (id, user_id, token_hash, created_at, expires_at, last_seen_at, ip, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const upsertAttempt = db.prepare(
    `INSERT INTO admin_login_attempts
      (id, key, window_start_ms, attempts, lock_until_ms, last_attempt_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        window_start_ms = excluded.window_start_ms,
        attempts = excluded.attempts,
        lock_until_ms = excluded.lock_until_ms,
        last_attempt_at_ms = excluded.last_attempt_at_ms`
  );

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const rawUser of Array.isArray(legacy.users) ? legacy.users : []) {
      const username = (rawUser.username || "").trim().toLowerCase();
      const passwordHash = (rawUser.passwordHash || "").trim();
      if (!username || !passwordHash) continue;
      insertUser.run(
        (rawUser.id || createId("admin_user")).trim(),
        username,
        passwordHash,
        (rawUser.role || "admin").trim() || "admin",
        rawUser.isActive === false ? 0 : 1,
        normalizeIso(rawUser.createdAt, nowStamp),
        normalizeIso(rawUser.updatedAt, nowStamp)
      );
    }

    for (const rawSession of Array.isArray(legacy.sessions) ? legacy.sessions : []) {
      const userId = (rawSession.userId || "").trim();
      const tokenHash = (rawSession.tokenHash || "").trim();
      if (!userId || !tokenHash) continue;
      insertSession.run(
        (rawSession.id || createId("admin_session")).trim(),
        userId,
        tokenHash,
        normalizeIso(rawSession.createdAt, nowStamp),
        normalizeIso(rawSession.expiresAt, nowStamp),
        normalizeIso(rawSession.lastSeenAt, nowStamp),
        (rawSession.ip || "").slice(0, 255),
        (rawSession.userAgent || "").slice(0, 500)
      );
    }

    for (const rawAttempt of Array.isArray(legacy.rateLimits) ? legacy.rateLimits : []) {
      const key = (rawAttempt.key || "").trim();
      if (!key) continue;
      const lockUntil = normalizeMs(rawAttempt.lockUntilMs, 0);
      upsertAttempt.run(
        (rawAttempt.id || createId("admin_rl")).trim(),
        key,
        normalizeMs(rawAttempt.windowStartMs, now),
        Math.max(0, normalizeMs(rawAttempt.attempts, 0)),
        lockUntil > 0 ? lockUntil : null,
        normalizeMs(rawAttempt.lastAttemptAtMs, now)
      );
    }

    setMetaValue(db, LEGACY_MIGRATION_KEY, "1");
    if (backupPath) {
      setMetaValue(db, `${LEGACY_MIGRATION_KEY}_backup_path`, backupPath);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function withAuthDb<T>(handler: (db: SqliteDb) => T): T {
  ensureAuthDbDirectory();
  const db = new DatabaseSync(getAuthDbPath());
  try {
    initializeSchema(db);
    runLegacyJsonMigration(db);
    return handler(db);
  } finally {
    db.close();
  }
}
