import assert from "node:assert/strict";
import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, it } from "node:test";
import {
  authenticateAdminCredentials,
  bootstrapAdminUser,
  createSessionToken,
  getBootstrapStatus,
  revokeSessionToken,
  verifySessionToken,
} from "../../../lib/admin/auth/session";
import { withAuthDb } from "../../../lib/admin/auth/sqlite-store";
import { getAuthDbPath, getAuthStorePath } from "../../../lib/admin/persistence/paths";

function legacyPasswordHash(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

function legacyTokenHash(secret: string, token: string): string {
  return crypto.createHash("sha256").update(`${secret}:${token}`).digest("hex");
}

function strongPassword(): string {
  return "StrongPass!123";
}

async function setupEnv(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-auth-"));
  process.env.ADMIN_DATA_DIR = tempDir;
  process.env.ADMIN_BOOTSTRAP_TOKEN = "bootstrap-token-1234567890";
  process.env.ADMIN_SESSION_SECRET = "session-secret-1234567890-abcdefghij";
  process.env.NODE_ENV = "test";
  return tempDir;
}

describe("admin auth sqlite", () => {
  it("allows bootstrap only when no users exist", async () => {
    await setupEnv();

    const first = bootstrapAdminUser({
      bootstrapToken: process.env.ADMIN_BOOTSTRAP_TOKEN || "",
      username: "admin",
      password: strongPassword(),
    });
    assert.equal(first.ok, true);
    assert.equal(first.status, 201);

    const second = bootstrapAdminUser({
      bootstrapToken: process.env.ADMIN_BOOTSTRAP_TOKEN || "",
      username: "admin2",
      password: strongPassword(),
    });
    assert.equal(second.ok, false);
    assert.equal(second.status, 409);
  });

  it("enforces password policy at bootstrap", async () => {
    await setupEnv();
    const weak = bootstrapAdminUser({
      bootstrapToken: process.env.ADMIN_BOOTSTRAP_TOKEN || "",
      username: "admin",
      password: "weakpass123",
    });
    assert.equal(weak.ok, false);
    assert.equal(weak.status, 400);
    assert.match(weak.error || "", /uppercase|symbol|characters/i);
  });

  it("handles login success and failure with lockout + retryAfter", async () => {
    await setupEnv();
    const created = bootstrapAdminUser({
      bootstrapToken: process.env.ADMIN_BOOTSTRAP_TOKEN || "",
      username: "admin",
      password: strongPassword(),
    });
    assert.equal(created.ok, true);

    for (let i = 0; i < 4; i += 1) {
      const failed = authenticateAdminCredentials("admin", "WrongPass!123", { ip: "127.0.0.1" });
      assert.equal(failed.ok, false);
      assert.equal(failed.status, 401);
      assert.equal(failed.error, "Invalid username or password.");
    }

    const locked = authenticateAdminCredentials("admin", "WrongPass!123", { ip: "127.0.0.1" });
    assert.equal(locked.ok, false);
    assert.equal(locked.status, 429);
    assert.ok((locked.retryAfter || 0) > 0);
    assert.ok((locked.retryAfterSeconds || 0) > 0);

    const stillLocked = authenticateAdminCredentials("admin", strongPassword(), { ip: "127.0.0.1" });
    assert.equal(stillLocked.ok, false);
    assert.equal(stillLocked.status, 429);
    assert.ok((stillLocked.retryAfter || 0) > 0);
  });

  it("creates verifies rotates and revokes sessions", async () => {
    await setupEnv();
    const created = bootstrapAdminUser({
      bootstrapToken: process.env.ADMIN_BOOTSTRAP_TOKEN || "",
      username: "admin",
      password: strongPassword(),
    });
    assert.equal(created.ok, true);

    const auth = authenticateAdminCredentials("admin", strongPassword(), { ip: "10.0.0.5" });
    assert.equal(auth.ok, true);
    assert.ok(auth.user);

    const token1 = createSessionToken(auth.user!, { ip: "10.0.0.5", userAgent: "test-agent" });
    const verified1 = verifySessionToken(token1);
    assert.equal(verified1?.username, "admin");

    const token2 = createSessionToken(auth.user!, { ip: "10.0.0.5", userAgent: "test-agent" });
    assert.equal(verifySessionToken(token1), null);
    assert.equal(verifySessionToken(token2)?.username, "admin");

    revokeSessionToken(token2);
    assert.equal(verifySessionToken(token2), null);
  });

  it("migrates legacy JSON auth store into sqlite with backup", async () => {
    const tempDir = await setupEnv();
    const legacyFile = getAuthStorePath();
    await fs.mkdir(path.dirname(legacyFile), { recursive: true });

    const userId = "admin_user_legacy";
    const token = "legacy-token";
    const secret = process.env.ADMIN_SESSION_SECRET || "";
    const legacy = {
      users: [
        {
          id: userId,
          username: "legacyadmin",
          passwordHash: legacyPasswordHash("LegacyPass!123"),
          role: "admin",
          isActive: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      sessions: [
        {
          id: "admin_session_legacy",
          userId,
          tokenHash: legacyTokenHash(secret, token),
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          lastSeenAt: new Date().toISOString(),
          ip: "127.0.0.1",
          userAgent: "legacy-agent",
        },
      ],
      rateLimits: [
        {
          id: "admin_rl_legacy",
          key: "127.0.0.1:legacyadmin",
          windowStartMs: Date.now(),
          attempts: 2,
          lockUntilMs: null,
          lastAttemptAtMs: Date.now(),
        },
      ],
    };
    await fs.writeFile(legacyFile, JSON.stringify(legacy, null, 2), "utf8");

    const bootstrap = getBootstrapStatus();
    assert.equal(bootstrap.needsBootstrap, false);

    const auth = authenticateAdminCredentials("legacyadmin", "LegacyPass!123", { ip: "127.0.0.1" });
    assert.equal(auth.ok, true);

    const migratedSession = verifySessionToken(token);
    assert.equal(migratedSession?.username, "legacyadmin");

    const dbPath = getAuthDbPath();
    const dbStat = await fs.stat(dbPath);
    assert.ok(dbStat.isFile());

    const backupFiles = (await fs.readdir(path.dirname(legacyFile))).filter((name) =>
      name.startsWith("admin-auth.json.backup-")
    );
    assert.ok(backupFiles.length >= 1);

    const counts = withAuthDb((db) => {
      const users = Number(db.prepare("SELECT COUNT(*) AS count FROM admin_users").get()?.count || 0);
      const sessions = Number(db.prepare("SELECT COUNT(*) AS count FROM admin_sessions").get()?.count || 0);
      return { users, sessions };
    });
    assert.ok(counts.users >= 1);
    assert.ok(counts.sessions >= 1);

    // Idempotence check: migration should not duplicate rows.
    const secondCounts = withAuthDb((db) => {
      const users = Number(db.prepare("SELECT COUNT(*) AS count FROM admin_users").get()?.count || 0);
      const sessions = Number(db.prepare("SELECT COUNT(*) AS count FROM admin_sessions").get()?.count || 0);
      return { users, sessions };
    });
    assert.equal(secondCounts.users, counts.users);
    assert.equal(secondCounts.sessions, counts.sessions);

    assert.equal(tempDir.length > 0, true);
  });
});
