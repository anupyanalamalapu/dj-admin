import path from "path";

export function getAdminDataRoot(): string {
  return process.env.ADMIN_DATA_DIR || path.join(process.cwd(), "data", "admin");
}

export function getStorePath(): string {
  return path.join(getAdminDataRoot(), "store", "admin-store.json");
}

export function getAuthStorePath(): string {
  return path.join(getAdminDataRoot(), "store", "admin-auth.json");
}

export function getAuthDbPath(): string {
  return path.join(getAdminDataRoot(), "store", "auth.db");
}

export function getClientsDir(): string {
  return path.join(getAdminDataRoot(), "clients");
}

export function getUploadsDir(): string {
  return path.join(getAdminDataRoot(), "uploads");
}

export function getContractsDir(): string {
  return path.join(getAdminDataRoot(), "contracts");
}
