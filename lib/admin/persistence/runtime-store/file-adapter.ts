import fs from "fs/promises";
import { AdminStore } from "../../types/models";
import { getStorePath } from "../paths";
import { RuntimeStoreAdapter } from "./adapter";
import { EMPTY_STORE, normalizeStore } from "./shared";

export const fileRuntimeStoreAdapter: RuntimeStoreAdapter = {
  async read(): Promise<AdminStore> {
    const storePath = getStorePath();
    const raw = await fs.readFile(storePath, "utf8");
    if (!raw.trim()) {
      return structuredClone(EMPTY_STORE);
    }
    try {
      return normalizeStore(JSON.parse(raw) as Partial<AdminStore>);
    } catch {
      return structuredClone(EMPTY_STORE);
    }
  },

  async write(store: AdminStore): Promise<void> {
    const storePath = getStorePath();
    const tempPath = `${storePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(store, null, 2), "utf8");
    await fs.rename(tempPath, storePath);
  },
};
