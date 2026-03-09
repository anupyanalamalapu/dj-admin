import path from "path";

function remapReadOnlyRoot(root: string): string {
  const normalized = path.resolve(root);
  if (normalized === "/var/task" || normalized.startsWith("/var/task/")) {
    const relative = path.relative("/var/task", normalized);
    return path.join("/tmp", relative);
  }
  return normalized;
}

export function getAdminDataRoot(): string {
  const configured = (process.env.ADMIN_DATA_DIR || "").trim();
  if (configured) {
    const resolvedConfigured = path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
    return remapReadOnlyRoot(resolvedConfigured);
  }

  return remapReadOnlyRoot(path.join(process.cwd(), "data", "admin"));
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
