export type BookingStage = "inquiry" | "in_contract" | "execution" | "cancelled" | "completed";

export type EventStatus =
  | "inquiry_received"
  | "needs_follow_up"
  | "quote_drafted"
  | "contract_drafted"
  | "contract_sent"
  | "contract_approved"
  | "deposit_received"
  | "booked"
  | "cancelled"
  | "completed";

export type DepositStatus = "none" | "requested" | "received";

export interface PricingRow {
  id: string;
  label: string;
  eventDate?: string;
  startTime?: string;
  endTime?: string;
  location?: string;
  amount: number;
}

export interface Client {
  id: string;
  fullName: string;
  email: string;
  phone?: string;
  instagramHandle?: string;
  location?: string;
  secondaryEmails: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceProfileCustomField {
  key: string;
  value: string;
}

export interface WorkspaceProfile {
  primaryClientName: string;
  primaryEmail: string;
  primaryPhone: string;
  primaryInstagramHandle: string;
  secondaryClientName: string;
  secondaryEmail: string;
  secondaryPhone: string;
  secondaryInstagramHandle: string;
  weddingPlannerName: string;
  weddingPlannerEmail: string;
  weddingPlannerPhone: string;
  weddingPlannerInstagramHandle: string;
  avVendorName: string;
  avVendorEmail: string;
  avVendorPhone: string;
  avVendorInstagramHandle: string;
  customFields: WorkspaceProfileCustomField[];
}

export interface AdminProfileSettings {
  baseHourlyRate: number;
  ownerName: string;
  ownerEmail: string;
  ownerPhone: string;
  ownerInstagramHandle: string;
}

export interface Inquiry {
  id: string;
  clientId: string;
  eventId: string;
  rawText: string;
  extractedText: string;
  source: "paste" | "upload" | "mixed";
  uploadedDocumentIds: string[];
  missingFields: string[];
  createdAt: string;
}

export interface Event {
  id: string;
  clientId: string;
  eventType?: string;
  eventDate?: string;
  eventDateTimestamp?: number;
  workspaceStartTimestamp?: number;
  workspaceEndTimestamp?: number;
  workspaceDateBoundsLocked?: boolean;
  venue?: string;
  servicesRequested: string[];
  guestCount?: number;
  duration?: string;
  status: EventStatus;
  depositStatus: DepositStatus;
  signedContract?: boolean;
  initialDepositReceived?: boolean;
  stage: BookingStage;
  contractId?: string;
  invoiceId?: string;
  inquiryIds: string[];
  communicationIds: string[];
  documentIds: string[];
  latestDraftEmail: string;
  lastApprovedDraftAt?: string;
  latestOcrText: string;
  latestInquirySummary?: string;
  latestNotes: string;
  amendmentSuggestion?: string;
  lastApprovedContractVersion?: number;
  lastApprovedContractTotalAmount?: number;
  lastApprovedContractDepositAmount?: number;
  needsAdjustedContractSignature?: boolean;
  adjustedContractSigned?: boolean;
  needsAdditionalDepositCollection?: boolean;
  additionalDepositCollected?: boolean;
  additionalDepositAmountDue?: number;
  stageOverride?: BookingStage;
  manualDocumentsCount?: number;
  profile?: WorkspaceProfile;
  createdAt: string;
  updatedAt: string;
}

export interface ContractDynamicFields {
  eventDetails: Array<{
    id: string;
    title: string;
    date: string;
    time: string;
    location: string;
    notes?: string;
    amount: number;
    manualOverridePrice?: number;
  }>;
  travelAmount: number;
  totalAmount: number;
  depositAmount: number;
  remainingAmount: number;
  dueDate: string;
  cancellationDate: string;
}

export interface Contract {
  id: string;
  eventId: string;
  clientId: string;
  version: number;
  status: "draft" | "sent" | "approved";
  dynamicFields: ContractDynamicFields;
  legalBody: string;
  renderedText: string;
  createdAt: string;
  updatedAt: string;
}

export interface Invoice {
  id: string;
  eventId: string;
  clientId: string;
  services: string[];
  amount: number;
  depositAmount: number;
  balanceRemaining: number;
  status: "draft" | "sent" | "paid_partial" | "paid";
  paymentDueDate?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentMeta {
  id: string;
  clientId: string;
  eventId?: string;
  filename: string;
  storedPath: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
}

export interface Communication {
  id: string;
  clientId: string;
  eventId: string;
  kind: "inbound" | "draft_email" | "note";
  content: string;
  createdAt: string;
}

export interface TrainingExample {
  id: string;
  clientId: string;
  eventId: string;
  stage: BookingStage;
  originalInquiry: string;
  generatedOutput: string;
  finalOutput: string;
  decision: "approved" | "edited" | "rejected";
  changeSummary?: string;
  artifactType?: "draft_email" | "contract";
  autoCaptured?: boolean;
  rawContextSnapshot?: string;
  contractDynamicFieldsSnapshot?: ContractDynamicFields;
  contractVersionSnapshot?: number;
  createdAt: string;
}

export interface AdminStore {
  adminProfile: AdminProfileSettings;
  clients: Client[];
  inquiries: Inquiry[];
  events: Event[];
  contracts: Contract[];
  invoices: Invoice[];
  documents: DocumentMeta[];
  communications: Communication[];
  trainingExamples: TrainingExample[];
}

export interface ExtractedInquiry {
  clientName?: string;
  email?: string;
  phone?: string;
  instagramHandle?: string;
  eventType?: string;
  eventLabel?: string;
  eventDate?: string;
  eventDateTimestamp?: number;
  eventEndDate?: string;
  eventEndDateTimestamp?: number;
  location?: string;
  servicesRequested: string[];
  guestCount?: number;
  duration?: string;
  timelineSegments?: Array<{
    title: string;
    time: string;
    date?: string;
    notes?: string;
  }>;
  missingFields: string[];
}

export interface WorkspaceSnapshot {
  client: Client;
  event: Event;
  inquiries: Inquiry[];
  contract?: Contract;
  invoice?: Invoice;
  documents: DocumentMeta[];
  communications: Communication[];
}

export interface WorkspaceListItem {
  eventId: string;
  clientId: string;
  clientName: string;
  clientEmail: string;
  clientPhone?: string;
  clientInstagramHandle?: string;
  primaryContact: string;
  workspaceTitle: string;
  latestContextSummary: string;
  stage: BookingStage;
  status: EventStatus;
  signedContract: boolean;
  initialDepositReceived: boolean;
  invoiceStatus?: Invoice["status"];
  eventType?: string;
  eventDate?: string;
  eventDateTimestamp?: number;
  workspaceStartTimestamp?: number;
  workspaceEndTimestamp?: number;
  venue?: string;
  contractTotalAmount: number;
  lastModifiedAt: string;
}
