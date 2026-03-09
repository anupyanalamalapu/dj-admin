import { AdminStore } from "../../types/models";

export const EMPTY_STORE: AdminStore = {
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

export function normalizeStore(parsed?: Partial<AdminStore>): AdminStore {
  const data = parsed || {};
  return {
    adminProfile: {
      baseHourlyRate:
        typeof data.adminProfile?.baseHourlyRate === "number" && Number.isFinite(data.adminProfile.baseHourlyRate)
          ? data.adminProfile.baseHourlyRate
          : 600,
      ownerName:
        typeof data.adminProfile?.ownerName === "string" && data.adminProfile.ownerName.trim()
          ? data.adminProfile.ownerName.trim()
          : "Anupya Nalamalapu",
      ownerEmail:
        typeof data.adminProfile?.ownerEmail === "string" && data.adminProfile.ownerEmail.trim()
          ? data.adminProfile.ownerEmail.trim().toLowerCase()
          : "djanupya@gmail.com",
      ownerPhone:
        typeof data.adminProfile?.ownerPhone === "string" && data.adminProfile.ownerPhone.trim()
          ? data.adminProfile.ownerPhone.trim()
          : "+1 408 887 2397",
      ownerInstagramHandle:
        typeof data.adminProfile?.ownerInstagramHandle === "string" && data.adminProfile.ownerInstagramHandle.trim()
          ? data.adminProfile.ownerInstagramHandle.trim()
          : "@djanupya",
    },
    clients: Array.isArray(data.clients) ? data.clients : [],
    inquiries: Array.isArray(data.inquiries) ? data.inquiries : [],
    events: Array.isArray(data.events) ? data.events : [],
    contracts: Array.isArray(data.contracts) ? data.contracts : [],
    invoices: Array.isArray(data.invoices) ? data.invoices : [],
    documents: Array.isArray(data.documents) ? data.documents : [],
    communications: Array.isArray(data.communications) ? data.communications : [],
    trainingExamples: Array.isArray(data.trainingExamples) ? data.trainingExamples : [],
  };
}
