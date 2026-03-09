import fs from "fs/promises";
import path from "path";
import { AdminStore } from "../types/models";
import { getStorePath } from "./paths";
import { RuntimeStoreAdapter } from "./runtime-store/adapter";
import { fileRuntimeStoreAdapter } from "./runtime-store/file-adapter";
import { hasPostgresRuntimeStoreConfig, postgresRuntimeStoreAdapter } from "./runtime-store/postgres-adapter";
import { EMPTY_STORE } from "./runtime-store/shared";

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

function getRuntimeStoreAdapter(): RuntimeStoreAdapter {
  if (hasPostgresRuntimeStoreConfig()) {
    return postgresRuntimeStoreAdapter;
  }
  return fileRuntimeStoreAdapter;
}

function assertProductionPostgresRuntimeStorage(): void {
  const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";
  if (process.env.NODE_ENV === "production" && !isBuildPhase && !hasPostgresRuntimeStoreConfig()) {
    throw new Error(
      "DATABASE_URL (or POSTGRES_URL) is required in production for runtime data storage. File fallback is disabled in production."
    );
  }
}

export async function ensureAdminDataLayout(): Promise<void> {
  assertProductionPostgresRuntimeStorage();

  if (hasPostgresRuntimeStoreConfig()) {
    return;
  }

  const storePath = getStorePath();
  await ensureDir(path.dirname(storePath));

  try {
    await fs.access(storePath);
  } catch {
    await fs.writeFile(storePath, JSON.stringify(EMPTY_STORE, null, 2), "utf8");
  }
}

export async function readStore(): Promise<AdminStore> {
  assertProductionPostgresRuntimeStorage();
  await ensureAdminDataLayout();
  return getRuntimeStoreAdapter().read();
}

export async function writeStore(store: AdminStore): Promise<void> {
  assertProductionPostgresRuntimeStorage();
  await ensureAdminDataLayout();
  await getRuntimeStoreAdapter().write(store);
}
