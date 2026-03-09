import fs from "fs/promises";
import path from "path";
import { AdminStore } from "../types/models";
import { getClientsDir, getContractsDir, getStorePath, getUploadsDir } from "./paths";
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
  return getRuntimeStoreAdapter().read();
}

export async function writeStore(store: AdminStore): Promise<void> {
  await ensureAdminDataLayout();
  await getRuntimeStoreAdapter().write(store);
}
