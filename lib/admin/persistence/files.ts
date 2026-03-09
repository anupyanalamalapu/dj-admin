import fs from "fs/promises";
import path from "path";
import { Pool } from "pg";
import { createId } from "../utils/id";
import { getAdminDataRoot } from "./paths";
import { hasPostgresRuntimeStoreConfig } from "./runtime-store/postgres-adapter";

const RUNTIME_FILES_TABLE = "admin_runtime_files";

type PgClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  release: () => void;
};

let poolPromise: Promise<Pool> | null = null;

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function normalizePosixPath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/^\/+/, "");
}

function nowIso(): string {
  return new Date().toISOString();
}

function getConnectionString(): string {
  const direct = (process.env.DATABASE_URL || "").trim();
  if (direct) return direct;
  const postgresUrl = (process.env.POSTGRES_URL || "").trim();
  if (postgresUrl) return postgresUrl;
  throw new Error("DATABASE_URL (or POSTGRES_URL) is required for Postgres file storage.");
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

async function withPg<T>(handler: (client: PgClient) => Promise<T>): Promise<T> {
  const pool = await getPgPool();
  const client = await pool.connect();
  try {
    return await handler(client);
  } finally {
    client.release();
  }
}

async function ensureRuntimeFilesSchema(client: PgClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${RUNTIME_FILES_TABLE} (
      key TEXT PRIMARY KEY,
      content BYTEA NOT NULL,
      mime_type TEXT,
      size_bytes INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
  `);
}

function toBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") {
    if (value.startsWith("\\x")) {
      return Buffer.from(value.slice(2), "hex");
    }
    return Buffer.from(value, "utf8");
  }
  return null;
}

function normalizeStorageKey(storedPath: string): string | null {
  const normalized = normalizePosixPath(storedPath || "");
  if (!normalized) return null;

  const directPrefixes = ["uploads/", "contracts/", "clients/"];
  for (const prefix of directPrefixes) {
    if (normalized.startsWith(prefix)) {
      return normalized;
    }
  }

  const lower = normalized.toLowerCase();
  for (const marker of ["/uploads/", "/contracts/", "/clients/"]) {
    const idx = lower.indexOf(marker);
    if (idx >= 0) {
      return normalized.slice(idx + 1);
    }
  }

  return null;
}

function absolutePathFromStorageKey(key: string): string {
  const safeKey = normalizePosixPath(key);
  return path.join(getAdminDataRoot(), ...safeKey.split("/"));
}

function legacyAbsolutePath(storedPath: string): string {
  return path.isAbsolute(storedPath) ? storedPath : path.resolve(process.cwd(), storedPath);
}

async function writeStoredBytes(args: { key: string; bytes: Buffer; mimeType?: string }): Promise<void> {
  const key = normalizePosixPath(args.key);
  if (hasPostgresRuntimeStoreConfig()) {
    await withPg(async (client) => {
      await ensureRuntimeFilesSchema(client);
      const now = nowIso();
      await client.query(
        `INSERT INTO ${RUNTIME_FILES_TABLE}(key, content, mime_type, size_bytes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT(key) DO UPDATE
           SET content = EXCLUDED.content,
               mime_type = EXCLUDED.mime_type,
               size_bytes = EXCLUDED.size_bytes,
               updated_at = EXCLUDED.updated_at`,
        [key, args.bytes, args.mimeType || null, args.bytes.byteLength, now, now]
      );
    });
    return;
  }

  const absolutePath = absolutePathFromStorageKey(key);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, args.bytes);
}

export async function readStoredFile(
  storedPath: string
): Promise<{ bytes: Buffer; mimeType?: string; sizeBytes: number } | null> {
  const key = normalizeStorageKey(storedPath);

  if (hasPostgresRuntimeStoreConfig() && key) {
    const fromPg = await withPg(async (client) => {
      await ensureRuntimeFilesSchema(client);
      const result = await client.query(
        `SELECT content, mime_type, size_bytes FROM ${RUNTIME_FILES_TABLE} WHERE key = $1 LIMIT 1`,
        [key]
      );
      const row = result.rows[0];
      if (!row) return null;
      const bytes = toBuffer(row.content);
      if (!bytes) return null;
      const sizeRaw = row.size_bytes;
      const sizeBytes =
        typeof sizeRaw === "number" && Number.isFinite(sizeRaw) ? sizeRaw : bytes.byteLength;
      return {
        bytes,
        mimeType: typeof row.mime_type === "string" ? row.mime_type : undefined,
        sizeBytes,
      };
    });
    if (fromPg) return fromPg;
  }

  const candidates = new Set<string>();
  if (key) {
    candidates.add(absolutePathFromStorageKey(key));
  }
  if (storedPath) {
    candidates.add(legacyAbsolutePath(storedPath));
  }

  for (const absolutePath of candidates) {
    try {
      const bytes = await fs.readFile(absolutePath);
      return { bytes, sizeBytes: bytes.byteLength };
    } catch {
      // continue fallback
    }
  }
  return null;
}

export async function deleteStoredFile(storedPath: string): Promise<void> {
  const key = normalizeStorageKey(storedPath);

  if (hasPostgresRuntimeStoreConfig() && key) {
    await withPg(async (client) => {
      await ensureRuntimeFilesSchema(client);
      await client.query(`DELETE FROM ${RUNTIME_FILES_TABLE} WHERE key = $1`, [key]);
    });
  }

  const candidates = new Set<string>();
  if (key) {
    candidates.add(absolutePathFromStorageKey(key));
  }
  if (storedPath) {
    candidates.add(legacyAbsolutePath(storedPath));
  }

  for (const absolutePath of candidates) {
    try {
      await fs.rm(absolutePath, { force: true });
    } catch {
      // Ignore cleanup failures.
    }
  }
}

export async function deleteStoredFilesByPrefix(prefix: string): Promise<void> {
  const normalizedPrefix = normalizePosixPath(prefix);
  if (!normalizedPrefix) return;

  if (hasPostgresRuntimeStoreConfig()) {
    await withPg(async (client) => {
      await ensureRuntimeFilesSchema(client);
      await client.query(`DELETE FROM ${RUNTIME_FILES_TABLE} WHERE key LIKE $1`, [`${normalizedPrefix}%`]);
    });
  }

  const absolutePrefixPath = absolutePathFromStorageKey(normalizedPrefix);
  try {
    await fs.rm(absolutePrefixPath, { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures.
  }
}

export async function saveUploadedFile(args: {
  file: File;
  clientId: string;
}): Promise<{ filename: string; relativePath: string; absolutePath: string; sizeBytes: number; mimeType: string }> {
  const safeName = sanitizeFilename(args.file.name || "upload.bin");
  const finalName = `${createId("doc")}_${safeName}`;
  const relativePath = path.posix.join("uploads", args.clientId, finalName);
  const data = Buffer.from(await args.file.arrayBuffer());
  const mimeType = args.file.type || "application/octet-stream";

  await writeStoredBytes({ key: relativePath, bytes: data, mimeType });

  return {
    filename: finalName,
    relativePath,
    absolutePath: hasPostgresRuntimeStoreConfig() ? relativePath : absolutePathFromStorageKey(relativePath),
    sizeBytes: data.byteLength,
    mimeType,
  };
}

export async function saveGeneratedContract(args: {
  eventId: string;
  version: number;
  text: string;
}): Promise<string> {
  const key = path.posix.join("contracts", "generated", args.eventId, `contract_v${args.version}.txt`);
  const bytes = Buffer.from(args.text, "utf8");
  await writeStoredBytes({ key, bytes, mimeType: "text/plain; charset=utf-8" });
  return key;
}

export async function saveClientMarkdownFile(args: { clientId: string; body: string }): Promise<string> {
  const key = path.posix.join("clients", `client_${args.clientId}.md`);
  const bytes = Buffer.from(args.body, "utf8");
  await writeStoredBytes({ key, bytes, mimeType: "text/markdown; charset=utf-8" });
  return key;
}
