import crypto from "crypto";
import { createId } from "../utils/id";
import { getAdminAuthEnvConfig } from "../config/runtime-config";
import { withPostgresClient } from "./postgres-store";

const SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const SESSION_TOUCH_INTERVAL_MS = 1000 * 60 * 5;
const RATE_LIMIT_WINDOW_MS = 1000 * 60 * 15;
const RATE_LIMIT_LOCK_MS = 1000 * 60 * 30;
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const PASSWORD_MIN_LENGTH = 12;

interface AuthUserRow {
  id: string;
  username: string;
  password_hash: string;
  is_active: boolean;
}

interface LoginAttemptRow {
  id: string;
  key: string;
  window_start_ms: number;
  attempts: number;
  lock_until_ms: number | null;
  last_attempt_at_ms: number;
}

interface LoginMeta {
  ip?: string;
  userAgent?: string;
}

interface BootstrapAdminInput {
  bootstrapToken: string;
  username: string;
  password: string;
}

interface AuthResult {
  ok: boolean;
  status: number;
  error?: string;
  retryAfter?: number;
  retryAfterSeconds?: number;
  user?: { id: string; username: string };
}

interface SessionPayload {
  userId: string;
  username: string;
  exp: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeUsername(value: string): string {
  return (value || "").trim().toLowerCase();
}

function normalizeIp(input?: string): string {
  const cleaned = (input || "").split(",")[0]?.trim();
  return cleaned || "unknown";
}

function normalizeUserAgent(input?: string): string {
  return (input || "").trim().slice(0, 500);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asIsoDateString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return "";
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "t" || normalized === "1" || normalized === "yes" || normalized === "y";
  }
  return false;
}

function getSessionSecretValidationError(): string | null {
  const secret = getAdminAuthEnvConfig().sessionSecret;
  if (!secret) {
    return "ADMIN_SESSION_SECRET is required. Set a long random secret before starting auth.";
  }
  if (secret.length < 32) {
    return "ADMIN_SESSION_SECRET must be at least 32 characters.";
  }
  return null;
}

function getSessionSecret(): string {
  const error = getSessionSecretValidationError();
  if (error) throw new Error(error);
  return getAdminAuthEnvConfig().sessionSecret;
}

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(`${getSessionSecret()}:${token}`).digest("hex");
}

function compareTokenSafe(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) {
    const providedDigest = crypto.createHash("sha256").update(provided).digest();
    const expectedDigest = crypto.createHash("sha256").update(expected).digest();
    return crypto.timingSafeEqual(providedDigest, expectedDigest) && false;
  }
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

function createPasswordHash(password: string): string {
  const salt = crypto.randomBytes(16);
  const n = 1 << 15;
  const r = 8;
  const p = 1;
  const keylen = 64;
  const derived = crypto.scryptSync(password, salt, keylen, {
    N: n,
    r,
    p,
    maxmem: 128 * 1024 * 1024,
  });
  return `scrypt$n=${n},r=${r},p=${p}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

function verifyPasswordHash(password: string, encoded: string): boolean {
  const parts = (encoded || "").split("$");
  if (parts[0] !== "scrypt") return false;

  if (parts.length === 3) {
    try {
      const salt = Buffer.from(parts[1], "base64url");
      const expected = Buffer.from(parts[2], "base64url");
      const actual = crypto.scryptSync(password, salt, expected.length);
      return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  if (parts.length !== 4) return false;
  const params = parts[1];
  const nMatch = params.match(/n=(\d+)/);
  const rMatch = params.match(/r=(\d+)/);
  const pMatch = params.match(/p=(\d+)/);
  if (!nMatch || !rMatch || !pMatch) return false;
  const n = Number(nMatch[1]);
  const r = Number(rMatch[1]);
  const p = Number(pMatch[1]);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  try {
    const salt = Buffer.from(parts[2], "base64url");
    const expected = Buffer.from(parts[3], "base64url");
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: 128 * 1024 * 1024,
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function passwordPolicyError(password: string): string | null {
  if ((password || "").length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (!/[a-z]/.test(password)) return "Password must include at least one lowercase letter.";
  if (!/[A-Z]/.test(password)) return "Password must include at least one uppercase letter.";
  if (!/\d/.test(password)) return "Password must include at least one number.";
  if (!/[^\w\s]/.test(password)) return "Password must include at least one symbol.";
  return null;
}

function rateLimitKey(username: string, ip?: string): string {
  return `${normalizeIp(ip)}:${normalizeUsername(username)}`;
}

async function pruneAuthStore(client: { query: (sql: string, params?: unknown[]) => Promise<any> }, nowMs: number): Promise<void> {
  await client.query("DELETE FROM admin_sessions WHERE expires_at <= NOW()");
  const staleCutoff = nowMs - RATE_LIMIT_LOCK_MS * 2;
  await client.query(
    `DELETE FROM admin_login_attempts
     WHERE (lock_until_ms IS NULL AND last_attempt_at_ms < $1)
        OR (lock_until_ms IS NOT NULL AND lock_until_ms < $2 AND last_attempt_at_ms < $1)`,
    [staleCutoff, nowMs]
  );
}

async function audit(client: { query: (sql: string, params?: unknown[]) => Promise<any> }, args: {
  action: string;
  username?: string;
  ip?: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  await client.query(
    `INSERT INTO admin_audit_log(id, action, username, ip, details_json, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      createId("admin_audit"),
      args.action,
      (args.username || "").trim().toLowerCase() || null,
      normalizeIp(args.ip),
      args.details ? JSON.stringify(args.details) : null,
      nowIso(),
    ]
  );
}

async function findActiveUserByUsername(
  client: { query: (sql: string, params?: unknown[]) => Promise<any> },
  username: string
): Promise<AuthUserRow | null> {
  const result = await client.query(
    `SELECT id, username, password_hash, is_active
     FROM admin_users
     WHERE username = $1 AND is_active = TRUE
     LIMIT 1`,
    [username]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: asString(row.id),
    username: asString(row.username),
    password_hash: asString(row.password_hash),
    is_active: asBoolean(row.is_active),
  };
}

async function getRateLimitRecord(
  client: { query: (sql: string, params?: unknown[]) => Promise<any> },
  key: string
): Promise<LoginAttemptRow | null> {
  const result = await client.query(
    `SELECT id, key, window_start_ms, attempts, lock_until_ms, last_attempt_at_ms
     FROM admin_login_attempts
     WHERE key = $1
     LIMIT 1`,
    [key]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: asString(row.id),
    key: asString(row.key),
    window_start_ms: asNumber(row.window_start_ms),
    attempts: asNumber(row.attempts),
    lock_until_ms: row.lock_until_ms == null ? null : asNumber(row.lock_until_ms),
    last_attempt_at_ms: asNumber(row.last_attempt_at_ms),
  };
}

async function upsertRateLimitRecord(
  client: { query: (sql: string, params?: unknown[]) => Promise<any> },
  record: LoginAttemptRow
): Promise<void> {
  await client.query(
    `INSERT INTO admin_login_attempts(id, key, window_start_ms, attempts, lock_until_ms, last_attempt_at_ms)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT(key) DO UPDATE SET
       id = EXCLUDED.id,
       window_start_ms = EXCLUDED.window_start_ms,
       attempts = EXCLUDED.attempts,
       lock_until_ms = EXCLUDED.lock_until_ms,
       last_attempt_at_ms = EXCLUDED.last_attempt_at_ms`,
    [record.id, record.key, record.window_start_ms, record.attempts, record.lock_until_ms, record.last_attempt_at_ms]
  );
}

export async function getBootstrapStatus(): Promise<{ needsBootstrap: boolean; bootstrapEnabled: boolean }> {
  return withPostgresClient(async (client) => {
    const countResult = await client.query("SELECT COUNT(*)::int AS count FROM admin_users");
    const count = asNumber(countResult.rows[0]?.count, 0);
    return {
      needsBootstrap: count === 0,
      bootstrapEnabled: Boolean(getAdminAuthEnvConfig().bootstrapToken),
    };
  });
}

export async function bootstrapAdminUser(
  input: BootstrapAdminInput
): Promise<{ ok: boolean; status: number; error?: string }> {
  const expectedToken = getAdminAuthEnvConfig().bootstrapToken;
  if (!expectedToken) {
    return { ok: false, status: 500, error: "Bootstrap is not configured. Set ADMIN_BOOTSTRAP_TOKEN." };
  }

  const providedToken = (input.bootstrapToken || "").trim();
  if (!providedToken || !compareTokenSafe(providedToken, expectedToken)) {
    return { ok: false, status: 401, error: "Invalid bootstrap token." };
  }

  const username = normalizeUsername(input.username);
  if (username.length < 3) {
    return { ok: false, status: 400, error: "Username must be at least 3 characters." };
  }
  const passwordError = passwordPolicyError(input.password || "");
  if (passwordError) {
    return { ok: false, status: 400, error: passwordError };
  }

  return withPostgresClient(async (client) => {
    await client.query("BEGIN");
    try {
      await pruneAuthStore(client, Date.now());
      const countResult = await client.query("SELECT COUNT(*)::int AS count FROM admin_users");
      const count = asNumber(countResult.rows[0]?.count, 0);
      if (count > 0) {
        await client.query("ROLLBACK");
        return { ok: false, status: 409, error: "Bootstrap already completed." };
      }

      await client.query(
        `INSERT INTO admin_users(id, username, password_hash, role, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [createId("admin_user"), username, createPasswordHash(input.password), "admin", true, nowIso(), nowIso()]
      );
      await audit(client, { action: "bootstrap_admin_created", username });
      await client.query("COMMIT");
      return { ok: true, status: 201 };
    } catch (error) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 500,
        error: error instanceof Error ? error.message : "Bootstrap failed.",
      };
    }
  });
}

export async function authenticateAdminCredentials(
  username: string,
  password: string,
  meta?: LoginMeta
): Promise<AuthResult> {
  const normalizedUser = normalizeUsername(username);
  const normalizedPass = password || "";
  if (!normalizedUser || !normalizedPass) {
    return { ok: false, status: 400, error: "Username and password are required." };
  }

  return withPostgresClient(async (client) => {
    const nowMs = Date.now();
    await pruneAuthStore(client, nowMs);

    const countResult = await client.query("SELECT COUNT(*)::int AS count FROM admin_users");
    if (asNumber(countResult.rows[0]?.count, 0) === 0) {
      return { ok: false, status: 409, error: "No admin users found. Complete bootstrap setup first." };
    }

    const rlKey = rateLimitKey(normalizedUser, meta?.ip);
    const record = (await getRateLimitRecord(client, rlKey)) || {
      id: createId("admin_rl"),
      key: rlKey,
      window_start_ms: nowMs,
      attempts: 0,
      lock_until_ms: null,
      last_attempt_at_ms: nowMs,
    };

    if (record.lock_until_ms && record.lock_until_ms > nowMs) {
      const retryAfter = Math.max(1, Math.ceil((record.lock_until_ms - nowMs) / 1000));
      await upsertRateLimitRecord(client, record);
      await audit(client, {
        action: "login_blocked_lockout",
        username: normalizedUser,
        ip: meta?.ip,
        details: { retryAfterSeconds: retryAfter },
      });
      return {
        ok: false,
        status: 429,
        error: "Too many failed attempts. Try again later.",
        retryAfter,
        retryAfterSeconds: retryAfter,
      };
    }

    if (nowMs - record.window_start_ms > RATE_LIMIT_WINDOW_MS) {
      record.window_start_ms = nowMs;
      record.attempts = 0;
      record.lock_until_ms = null;
    }

    const user = await findActiveUserByUsername(client, normalizedUser);
    const passwordOk = user ? verifyPasswordHash(normalizedPass, user.password_hash) : false;
    if (!passwordOk || !user) {
      record.attempts += 1;
      record.last_attempt_at_ms = nowMs;
      if (record.attempts >= RATE_LIMIT_MAX_ATTEMPTS) {
        record.lock_until_ms = nowMs + RATE_LIMIT_LOCK_MS;
      }
      await upsertRateLimitRecord(client, record);
      const retryAfter = record.lock_until_ms ? Math.max(1, Math.ceil((record.lock_until_ms - nowMs) / 1000)) : undefined;
      await audit(client, {
        action: "login_failed",
        username: normalizedUser,
        ip: meta?.ip,
        details: { attempts: record.attempts, locked: Boolean(record.lock_until_ms) },
      });
      return {
        ok: false,
        status: record.lock_until_ms ? 429 : 401,
        error: record.lock_until_ms ? "Too many failed attempts. Try again later." : "Invalid username or password.",
        retryAfter,
        retryAfterSeconds: retryAfter,
      };
    }

    await client.query("DELETE FROM admin_login_attempts WHERE key = $1", [rlKey]);
    await audit(client, { action: "login_succeeded", username: user.username, ip: meta?.ip });
    return { ok: true, status: 200, user: { id: user.id, username: user.username } };
  });
}

export async function createSessionToken(
  user: { id: string; username: string },
  meta?: LoginMeta
): Promise<string> {
  const secretError = getSessionSecretValidationError();
  if (secretError) throw new Error(secretError);

  return withPostgresClient(async (client) => {
    const nowMs = Date.now();
    await pruneAuthStore(client, nowMs);
    const token = crypto.randomBytes(32).toString("base64url");
    const hash = tokenHash(token);

    await client.query("BEGIN");
    try {
      await client.query("DELETE FROM admin_sessions WHERE user_id = $1", [user.id]);
      await client.query(
        `INSERT INTO admin_sessions(id, user_id, token_hash, created_at, expires_at, last_seen_at, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          createId("admin_session"),
          user.id,
          hash,
          nowIso(),
          new Date(nowMs + SESSION_TTL_MS).toISOString(),
          nowIso(),
          normalizeIp(meta?.ip),
          normalizeUserAgent(meta?.userAgent),
        ]
      );
      await audit(client, { action: "session_created", username: user.username, ip: meta?.ip });
      await client.query("COMMIT");
      return token;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function revokeSessionToken(token: string | undefined): Promise<void> {
  if (!token) return;
  const secretError = getSessionSecretValidationError();
  if (secretError) return;

  await withPostgresClient(async (client) => {
    const hash = tokenHash(token);
    const rowResult = await client.query(
      `SELECT s.id, u.username
       FROM admin_sessions s
       LEFT JOIN admin_users u ON u.id = s.user_id
       WHERE s.token_hash = $1
       LIMIT 1`,
      [hash]
    );
    await client.query("DELETE FROM admin_sessions WHERE token_hash = $1", [hash]);
    const row = rowResult.rows[0];
    if (row) {
      await audit(client, { action: "logout", username: asString(row.username) });
    }
  });
}

export async function verifySessionToken(token: string | undefined): Promise<SessionPayload | null> {
  if (!token) return null;
  const secretError = getSessionSecretValidationError();
  if (secretError) return null;

  return withPostgresClient(async (client) => {
    const nowMs = Date.now();
    await pruneAuthStore(client, nowMs);

    const hash = tokenHash(token);
    const result = await client.query(
      `SELECT s.id, s.user_id, s.expires_at, s.last_seen_at, u.username, u.is_active
       FROM admin_sessions s
       JOIN admin_users u ON u.id = s.user_id
       WHERE s.token_hash = $1
       LIMIT 1`,
      [hash]
    );
    const row = result.rows[0];
    if (!row) return null;

    const expiresAtIso = asIsoDateString(row.expires_at);
    const expiresAtMs = Date.parse(expiresAtIso);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs || !asBoolean(row.is_active)) {
      await client.query("DELETE FROM admin_sessions WHERE id = $1", [asString(row.id)]);
      return null;
    }

    const lastSeenMs = Date.parse(asIsoDateString(row.last_seen_at));
    const shouldTouch = !Number.isFinite(lastSeenMs) || nowMs - lastSeenMs >= SESSION_TOUCH_INTERVAL_MS;
    const nextExpiryIso = new Date(nowMs + SESSION_TTL_MS).toISOString();
    if (shouldTouch) {
      await client.query("UPDATE admin_sessions SET last_seen_at = $1, expires_at = $2 WHERE id = $3", [
        nowIso(),
        nextExpiryIso,
        asString(row.id),
      ]);
    }
    const effectiveExpiryIso = shouldTouch ? nextExpiryIso : expiresAtIso;
    return {
      userId: asString(row.user_id),
      username: asString(row.username),
      exp: Date.parse(effectiveExpiryIso),
    };
  });
}
