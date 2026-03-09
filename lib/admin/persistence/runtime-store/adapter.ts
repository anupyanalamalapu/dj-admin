import { AdminStore } from "../../types/models";

export interface RuntimeStoreAdapter {
  read: () => Promise<AdminStore>;
  write: (store: AdminStore) => Promise<void>;
}
