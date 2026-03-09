import fs from "fs/promises";
import path from "path";
import { AdminStore } from "../types/models";
import { getClientsDir, getContractsDir, getStorePath, getUploadsDir } from "./paths";

const EMPTY_STORE: AdminStore = {
  adminProfile: {
    baseHourlyRate: 600,
    ownerName: "Anupya Nalamalapu",
    ownerEmail: "djanupya@gmail.com",
    ownerPhone: "+1 408 887 2397",
    ownerInstagramHandle: "@djanupya",
  },
  clients: [],
  inquiries: [],
  events: [],
  contracts: [],
  invoices: [],
  documents: [],
  communications: [],
  trainingExamples: [],
};

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
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
  const storePath = getStorePath();
  const raw = await fs.readFile(storePath, "utf8");
  if (!raw.trim()) {
    return structuredClone(EMPTY_STORE);
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AdminStore>;
    return {
      adminProfile: {
        baseHourlyRate:
          typeof parsed.adminProfile?.baseHourlyRate === "number" && Number.isFinite(parsed.adminProfile.baseHourlyRate)
            ? parsed.adminProfile.baseHourlyRate
            : 600,
        ownerName:
          typeof parsed.adminProfile?.ownerName === "string" && parsed.adminProfile.ownerName.trim()
            ? parsed.adminProfile.ownerName.trim()
            : "Anupya Nalamalapu",
        ownerEmail:
          typeof parsed.adminProfile?.ownerEmail === "string" && parsed.adminProfile.ownerEmail.trim()
            ? parsed.adminProfile.ownerEmail.trim().toLowerCase()
            : "djanupya@gmail.com",
        ownerPhone:
          typeof parsed.adminProfile?.ownerPhone === "string" && parsed.adminProfile.ownerPhone.trim()
            ? parsed.adminProfile.ownerPhone.trim()
            : "+1 408 887 2397",
        ownerInstagramHandle:
          typeof parsed.adminProfile?.ownerInstagramHandle === "string" && parsed.adminProfile.ownerInstagramHandle.trim()
            ? parsed.adminProfile.ownerInstagramHandle.trim()
            : "@djanupya",
      },
      clients: parsed.clients || [],
      inquiries: parsed.inquiries || [],
      events: parsed.events || [],
      contracts: parsed.contracts || [],
      invoices: parsed.invoices || [],
      documents: parsed.documents || [],
      communications: parsed.communications || [],
      trainingExamples: parsed.trainingExamples || [],
    };
  } catch {
    return structuredClone(EMPTY_STORE);
  }
}

export async function writeStore(store: AdminStore): Promise<void> {
  await ensureAdminDataLayout();
  const storePath = getStorePath();
  const tempPath = `${storePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tempPath, storePath);
}
