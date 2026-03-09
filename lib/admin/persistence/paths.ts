import path from "path";

export function getAdminDataRoot(): string {
  const configured = (process.env.ADMIN_DATA_DIR || "").trim();
  const isVercel = process.env.VERCEL === "1" || Boolean(process.env.VERCEL_ENV);
  if (configured) {
    if (isVercel && !path.isAbsolute(configured)) {
      const normalized = configured.replace(/^[./\\]+/, "");
      return path.join("/tmp", normalized || path.join("data", "admin"));
    }
    return configured;
  }

  // Vercel serverless runtime file system is read-only except /tmp.
  if (isVercel) {
    return path.join("/tmp", "data", "admin");
  }

  return path.join(process.cwd(), "data", "admin");
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
