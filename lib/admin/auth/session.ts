import * as sqliteSession from "./session-sqlite";
import * as postgresSession from "./session-postgres";
import { hasPostgresConfig } from "./postgres-store";

function usePostgres(): boolean {
  return hasPostgresConfig();
}

export function getCookieName(): string {
  return sqliteSession.getCookieName();
}

export function getSessionTtlSeconds(): number {
  return sqliteSession.getSessionTtlSeconds();
}

export function getSessionCookieOptions() {
  return sqliteSession.getSessionCookieOptions();
}

export async function getBootstrapStatus(): Promise<{ needsBootstrap: boolean; bootstrapEnabled: boolean }> {
  if (usePostgres()) {
    return postgresSession.getBootstrapStatus();
  }
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
  return sqliteSession.authenticateAdminCredentials(username, password, meta);
}

export async function createSessionToken(
  user: { id: string; username: string },
  meta?: { ip?: string; userAgent?: string }
): Promise<string> {
  if (usePostgres()) {
    return postgresSession.createSessionToken(user, meta);
  }
  return sqliteSession.createSessionToken(user, meta);
}

export async function revokeSessionToken(token: string | undefined): Promise<void> {
  if (usePostgres()) {
    await postgresSession.revokeSessionToken(token);
    return;
  }
  sqliteSession.revokeSessionToken(token);
}

export async function verifySessionToken(
  token: string | undefined
): Promise<{ userId: string; username: string; exp: number } | null> {
  if (usePostgres()) {
    return postgresSession.verifySessionToken(token);
  }
  return sqliteSession.verifySessionToken(token);
}
