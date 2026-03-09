import crypto from "crypto";
import { createId } from "../utils/id";
import { withAuthDb } from "./sqlite-store";
import { getAdminAuthEnvConfig } from "../config/runtime-config";

const COOKIE_NAME = "admin_session";
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
  role: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

interface AuthSessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  ip: string | null;
  user_agent: string | null;
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

interface SessionCookieOptions {
  httpOnly: true;
  sameSite: "strict";
  secure: boolean;
  maxAge: number;
  path: "/";
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
  if (error) {
    throw new Error(error);
  }
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

  // Backward compatibility with legacy JSON auth hashes: scrypt$<salt>$<hash>
  if (parts.length === 3) {
    try {
      const salt = Buffer.from(parts[1], "base64url");
      const expected = Buffer.from(parts[2], "base64url");
      const actual = crypto.scryptSync(password, salt, expected.length);
      if (actual.length !== expected.length) return false;
      return crypto.timingSafeEqual(actual, expected);
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
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function passwordPolicyError(password: string): string | null {
  if ((password || "").length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (!/[a-z]/.test(password)) {
    return "Password must include at least one lowercase letter.";
  }
  if (!/[A-Z]/.test(password)) {
    return "Password must include at least one uppercase letter.";
  }
  if (!/\d/.test(password)) {
    return "Password must include at least one number.";
  }
  if (!/[^\w\s]/.test(password)) {
    return "Password must include at least one symbol.";
  }
  return null;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function getUserCount(): number {
  return withAuthDb((db) => {
    const row = db.prepare("SELECT COUNT(*) AS count FROM admin_users").get();
    return Math.max(0, asNumber(row?.count, 0));
  });
}

function pruneAuthStore(db: { prepare: (sql: string) => SqlStatementFactory }, nowMs: number): void {
  const nowStamp = new Date(nowMs).toISOString();
  db.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").run(nowStamp);

  const staleCutoff = nowMs - RATE_LIMIT_LOCK_MS * 2;
  db.prepare(
    `DELETE FROM admin_login_attempts
     WHERE lock_until_ms IS NULL
       AND last_attempt_at_ms < ?`
  ).run(staleCutoff);
  db.prepare(
    `DELETE FROM admin_login_attempts
     WHERE lock_until_ms IS NOT NULL
       AND lock_until_ms < ?
       AND last_attempt_at_ms < ?`
  ).run(nowMs, staleCutoff);
}

type SqlStatementFactory = {
  get: (...params: unknown[]) => Record<string, unknown> | undefined;
  run: (...params: unknown[]) => Record<string, unknown>;
};

function rateLimitKey(username: string, ip?: string): string {
  return `${normalizeIp(ip)}:${normalizeUsername(username)}`;
}

function getRateLimitRecord(db: { prepare: (sql: string) => SqlStatementFactory }, key: string): LoginAttemptRow | null {
  const row = db
    .prepare(
      `SELECT id, key, window_start_ms, attempts, lock_until_ms, last_attempt_at_ms
       FROM admin_login_attempts
       WHERE key = ?`
    )
    .get(key);
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

function writeRateLimitRecord(db: { prepare: (sql: string) => SqlStatementFactory }, record: LoginAttemptRow): void {
  db.prepare(
    `INSERT INTO admin_login_attempts(id, key, window_start_ms, attempts, lock_until_ms, last_attempt_at_ms)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       id = excluded.id,
       window_start_ms = excluded.window_start_ms,
       attempts = excluded.attempts,
       lock_until_ms = excluded.lock_until_ms,
       last_attempt_at_ms = excluded.last_attempt_at_ms`
  ).run(
    record.id,
    record.key,
    record.window_start_ms,
    record.attempts,
    record.lock_until_ms,
    record.last_attempt_at_ms
  );
}

function audit(db: { prepare: (sql: string) => SqlStatementFactory }, args: {
  action: string;
  username?: string;
  ip?: string;
  details?: Record<string, unknown>;
}): void {
  db.prepare(
    `INSERT INTO admin_audit_log(id, action, username, ip, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    createId("admin_audit"),
    args.action,
    (args.username || "").trim().toLowerCase() || null,
    normalizeIp(args.ip),
    args.details ? JSON.stringify(args.details) : null,
    nowIso()
  );
}

function findActiveUserByUsername(
  db: { prepare: (sql: string) => SqlStatementFactory },
  username: string
): AuthUserRow | null {
  const row = db
    .prepare(
      `SELECT id, username, password_hash, role, is_active, created_at, updated_at
       FROM admin_users
       WHERE username = ? AND is_active = 1
       LIMIT 1`
    )
    .get(username);
  if (!row) return null;
  return {
    id: asString(row.id),
    username: asString(row.username),
    password_hash: asString(row.password_hash),
    role: asString(row.role),
    is_active: asNumber(row.is_active),
    created_at: asString(row.created_at),
    updated_at: asString(row.updated_at),
  };
}

export function getCookieName(): string {
  return COOKIE_NAME;
}

export function getSessionTtlSeconds(): number {
  return Math.floor(SESSION_TTL_MS / 1000);
}

export function getSessionCookieOptions(): SessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: getSessionTtlSeconds(),
    path: "/",
  };
}

export function getBootstrapStatus(): { needsBootstrap: boolean; bootstrapEnabled: boolean } {
  const authConfig = getAdminAuthEnvConfig();
  return {
    needsBootstrap: getUserCount() === 0,
    bootstrapEnabled: Boolean(authConfig.bootstrapToken),
  };
}

export function bootstrapAdminUser(input: BootstrapAdminInput): { ok: boolean; status: number; error?: string } {
  const expectedToken = getAdminAuthEnvConfig().bootstrapToken;
  if (!expectedToken) {
    return {
      ok: false,
      status: 500,
      error: "Bootstrap is not configured. Set ADMIN_BOOTSTRAP_TOKEN.",
    };
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

  try {
    return withAuthDb((db) => {
      const nowMs = Date.now();
      pruneAuthStore(db, nowMs);

      const countRow = db.prepare("SELECT COUNT(*) AS count FROM admin_users").get();
      if (asNumber(countRow?.count, 0) > 0) {
        return { ok: false, status: 409, error: "Bootstrap already completed." };
      }

      db.prepare(
        `INSERT INTO admin_users(id, username, password_hash, role, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(createId("admin_user"), username, createPasswordHash(input.password), "admin", 1, nowIso(), nowIso());

      audit(db, { action: "bootstrap_admin_created", username });
      return { ok: true, status: 201 };
    });
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: error instanceof Error ? error.message : "Bootstrap failed.",
    };
  }
}

export function authenticateAdminCredentials(
  username: string,
  password: string,
  meta?: LoginMeta
): AuthResult {
  const normalizedUser = normalizeUsername(username);
  const normalizedPass = password || "";
  if (!normalizedUser || !normalizedPass) {
    return { ok: false, status: 400, error: "Username and password are required." };
  }

  return withAuthDb((db) => {
    const nowMs = Date.now();
    pruneAuthStore(db, nowMs);

    const countRow = db.prepare("SELECT COUNT(*) AS count FROM admin_users").get();
    if (asNumber(countRow?.count, 0) === 0) {
      return {
        ok: false,
        status: 409,
        error: "No admin users found. Complete bootstrap setup first.",
      };
    }

    const rlKey = rateLimitKey(normalizedUser, meta?.ip);
    const record = getRateLimitRecord(db, rlKey) || {
      id: createId("admin_rl"),
      key: rlKey,
      window_start_ms: nowMs,
      attempts: 0,
      lock_until_ms: null,
      last_attempt_at_ms: nowMs,
    };

    if (record.lock_until_ms && record.lock_until_ms > nowMs) {
      const retryAfter = Math.max(1, Math.ceil((record.lock_until_ms - nowMs) / 1000));
      writeRateLimitRecord(db, record);
      audit(db, {
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

    const user = findActiveUserByUsername(db, normalizedUser);
    const passwordOk = user ? verifyPasswordHash(normalizedPass, user.password_hash) : false;

    if (!passwordOk || !user) {
      record.attempts += 1;
      record.last_attempt_at_ms = nowMs;
      if (record.attempts >= RATE_LIMIT_MAX_ATTEMPTS) {
        record.lock_until_ms = nowMs + RATE_LIMIT_LOCK_MS;
      }
      writeRateLimitRecord(db, record);

      const retryAfter = record.lock_until_ms ? Math.max(1, Math.ceil((record.lock_until_ms - nowMs) / 1000)) : undefined;
      audit(db, {
        action: "login_failed",
        username: normalizedUser,
        ip: meta?.ip,
        details: {
          attempts: record.attempts,
          locked: Boolean(record.lock_until_ms),
        },
      });

      return {
        ok: false,
        status: record.lock_until_ms ? 429 : 401,
        error: record.lock_until_ms ? "Too many failed attempts. Try again later." : "Invalid username or password.",
        retryAfter,
        retryAfterSeconds: retryAfter,
      };
    }

    db.prepare("DELETE FROM admin_login_attempts WHERE key = ?").run(rlKey);
    audit(db, { action: "login_succeeded", username: user.username, ip: meta?.ip });

    return {
      ok: true,
      status: 200,
      user: { id: user.id, username: user.username },
    };
  });
}

export function createSessionToken(
  user: { id: string; username: string },
  meta?: LoginMeta
): string {
  const secretError = getSessionSecretValidationError();
  if (secretError) {
    throw new Error(secretError);
  }

  return withAuthDb((db) => {
    const nowMs = Date.now();
    pruneAuthStore(db, nowMs);

    const token = crypto.randomBytes(32).toString("base64url");
    const session: AuthSessionRow = {
      id: createId("admin_session"),
      user_id: user.id,
      token_hash: tokenHash(token),
      created_at: nowIso(),
      expires_at: new Date(nowMs + SESSION_TTL_MS).toISOString(),
      last_seen_at: nowIso(),
      ip: normalizeIp(meta?.ip),
      user_agent: normalizeUserAgent(meta?.userAgent),
    };

    // Session rotation: keep only one active session per user.
    db.prepare("DELETE FROM admin_sessions WHERE user_id = ?").run(user.id);
    db.prepare(
      `INSERT INTO admin_sessions
        (id, user_id, token_hash, created_at, expires_at, last_seen_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      session.id,
      session.user_id,
      session.token_hash,
      session.created_at,
      session.expires_at,
      session.last_seen_at,
      session.ip,
      session.user_agent
    );

    audit(db, {
      action: "session_created",
      username: user.username,
      ip: meta?.ip,
    });

    return token;
  });
}

export function revokeSessionToken(token: string | undefined): void {
  if (!token) return;
  const secretError = getSessionSecretValidationError();
  if (secretError) return;

  withAuthDb((db) => {
    const hashed = tokenHash(token);
    const row = db
      .prepare(
        `SELECT s.id, u.username
         FROM admin_sessions s
         LEFT JOIN admin_users u ON u.id = s.user_id
         WHERE s.token_hash = ?`
      )
      .get(hashed);
    db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(hashed);
    if (row) {
      audit(db, {
        action: "logout",
        username: asString(row.username),
      });
    }
  });
}

export function verifySessionToken(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const secretError = getSessionSecretValidationError();
  if (secretError) return null;

  return withAuthDb((db) => {
    const nowMs = Date.now();
    pruneAuthStore(db, nowMs);

    const hashed = tokenHash(token);
    const row = db
      .prepare(
        `SELECT
          s.id,
          s.user_id,
          s.expires_at,
          s.last_seen_at,
          u.username,
          u.is_active
         FROM admin_sessions s
         JOIN admin_users u ON u.id = s.user_id
         WHERE s.token_hash = ?
         LIMIT 1`
      )
      .get(hashed);
    if (!row) return null;

    const expiresAtMs = Date.parse(asString(row.expires_at));
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs || asNumber(row.is_active, 0) !== 1) {
      db.prepare("DELETE FROM admin_sessions WHERE id = ?").run(asString(row.id));
      return null;
    }

    const lastSeenMs = Date.parse(asString(row.last_seen_at));
    const shouldTouch = !Number.isFinite(lastSeenMs) || nowMs - lastSeenMs >= SESSION_TOUCH_INTERVAL_MS;
    const nextExpiryIso = new Date(nowMs + SESSION_TTL_MS).toISOString();
    if (shouldTouch) {
      db.prepare("UPDATE admin_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?").run(
        nowIso(),
        nextExpiryIso,
        asString(row.id)
      );
    }
    const effectiveExpiryIso = shouldTouch ? nextExpiryIso : asString(row.expires_at);

    return {
      userId: asString(row.user_id),
      username: asString(row.username),
      exp: Date.parse(effectiveExpiryIso),
    };
  });
}
