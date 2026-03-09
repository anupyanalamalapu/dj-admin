import * as postgresSession from "./session-postgres";
import { hasPostgresConfig } from "./postgres-store";

const COOKIE_NAME = "admin_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;

function usePostgres(): boolean {
  return hasPostgresConfig();
}

async function loadSqliteSession() {
  return import("./session-sqlite");
}

export function getCookieName(): string {
  return COOKIE_NAME;
}

export function getSessionTtlSeconds(): number {
  return Math.floor(SESSION_TTL_MS / 1000);
}

export function getSessionCookieOptions() {
  return {
    httpOnly: true as const,
    sameSite: "strict" as const,
    secure: process.env.NODE_ENV === "production",
    maxAge: getSessionTtlSeconds(),
    path: "/" as const,
  };
}

export async function getBootstrapStatus(): Promise<{ needsBootstrap: boolean; bootstrapEnabled: boolean }> {
  if (usePostgres()) {
    return postgresSession.getBootstrapStatus();
  }
  const sqliteSession = await loadSqliteSession();
  return sqliteSession.getBootstrapStatus();
}

export async function bootstrapAdminUser(input: {
  bootstrapToken: string;
  username: string;
  password: string;
}): Promise<{ ok: boolean; status: number; error?: string }> {
  if (usePostgres()) {
    return postgresSession.bootstrapAdminUser(input);
  }
  const sqliteSession = await loadSqliteSession();
  return sqliteSession.bootstrapAdminUser(input);
}

export async function authenticateAdminCredentials(
  username: string,
  password: string,
  meta?: { ip?: string; userAgent?: string }
): Promise<{
  ok: boolean;
  status: number;
  error?: string;
  retryAfter?: number;
  retryAfterSeconds?: number;
  user?: { id: string; username: string };
}> {
  if (usePostgres()) {
    return postgresSession.authenticateAdminCredentials(username, password, meta);
  }
  const sqliteSession = await loadSqliteSession();
  return sqliteSession.authenticateAdminCredentials(username, password, meta);
}

export async function createSessionToken(
  user: { id: string; username: string },
  meta?: { ip?: string; userAgent?: string }
): Promise<string> {
  if (usePostgres()) {
    return postgresSession.createSessionToken(user, meta);
  }
  const sqliteSession = await loadSqliteSession();
  return sqliteSession.createSessionToken(user, meta);
}

export async function revokeSessionToken(token: string | undefined): Promise<void> {
  if (usePostgres()) {
    await postgresSession.revokeSessionToken(token);
    return;
  }
  const sqliteSession = await loadSqliteSession();
  sqliteSession.revokeSessionToken(token);
}

export async function verifySessionToken(
  token: string | undefined
): Promise<{ userId: string; username: string; exp: number } | null> {
  if (usePostgres()) {
    return postgresSession.verifySessionToken(token);
  }
  const sqliteSession = await loadSqliteSession();
  return sqliteSession.verifySessionToken(token);
}
