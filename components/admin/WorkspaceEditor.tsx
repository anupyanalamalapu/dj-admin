"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import StageBadge from "@/components/admin/StageBadge";
import { BookingStage, ContractDynamicFields, WorkspaceProfile, WorkspaceSnapshot } from "@/lib/admin/types/models";
import { CONTRACT_LEGAL_BODY } from "@/lib/admin/contracts/template";
import { renderContract, renderContractHtml } from "@/lib/admin/contracts/generate";
import { formatDateLong, formatDateTimeRange, parseDateToTimestamp, timestampToIsoDate } from "@/lib/admin/utils/date";

interface WorkspaceEditorProps {
  initial: WorkspaceSnapshot;
  ocrManualMode: boolean;
}

function preferredContact(profile: WorkspaceProfile, client: WorkspaceSnapshot["client"]): string {
  const primaryEmail = (profile.primaryEmail || "").trim().toLowerCase();
  if (primaryEmail && !primaryEmail.endsWith("@example.local")) return profile.primaryEmail.trim();
  if ((profile.primaryPhone || "").trim()) return profile.primaryPhone.trim();
  if ((profile.primaryInstagramHandle || "").trim()) return profile.primaryInstagramHandle.trim();

  const email = (client.email || "").trim().toLowerCase();
  if (email && !email.endsWith("@example.local")) return client.email;
  if ((client.phone || "").trim()) return client.phone!.trim();
  if ((client.instagramHandle || "").trim()) return client.instagramHandle!.trim();
  return client.email || "-";
}

function normalizeProfileValue(value?: string): string {
  return (value || "").replace(/\s+/g, " ").trim();
}

function profileFromSnapshot(snapshot: WorkspaceSnapshot): WorkspaceProfile {
  const source = snapshot.event.profile;
  const clientName = normalizeProfileValue(snapshot.client.fullName);
  const clientEmail = normalizeProfileValue(snapshot.client.email);
  const clientPhone = normalizeProfileValue(snapshot.client.phone);
  const clientInstagram = normalizeProfileValue(snapshot.client.instagramHandle);
  return {
    primaryClientName: clientName || normalizeProfileValue(source?.primaryClientName),
    primaryEmail: clientEmail || normalizeProfileValue(source?.primaryEmail),
    primaryPhone: clientPhone || normalizeProfileValue(source?.primaryPhone),
    primaryInstagramHandle: clientInstagram || normalizeProfileValue(source?.primaryInstagramHandle),
    secondaryClientName: normalizeProfileValue(source?.secondaryClientName),
    secondaryEmail: normalizeProfileValue(source?.secondaryEmail),
    secondaryPhone: normalizeProfileValue(source?.secondaryPhone),
    secondaryInstagramHandle: normalizeProfileValue(source?.secondaryInstagramHandle),
    weddingPlannerName: normalizeProfileValue(source?.weddingPlannerName),
    weddingPlannerEmail: normalizeProfileValue(source?.weddingPlannerEmail),
    weddingPlannerPhone: normalizeProfileValue(source?.weddingPlannerPhone),
    weddingPlannerInstagramHandle: normalizeProfileValue(source?.weddingPlannerInstagramHandle),
    avVendorName: normalizeProfileValue(source?.avVendorName),
    avVendorEmail: normalizeProfileValue(source?.avVendorEmail),
    avVendorPhone: normalizeProfileValue(source?.avVendorPhone),
    avVendorInstagramHandle: normalizeProfileValue(source?.avVendorInstagramHandle),
    customFields: (source?.customFields || [])
      .map((item) => ({
        key: normalizeProfileValue(item.key),
        value: normalizeProfileValue(item.value),
      }))
      .filter((item) => item.key || item.value),
  };
}

interface WorkspaceMetaDraft {
  workspaceStartAt: string;
  workspaceEndAt: string;
  dateOnly: boolean;
  stage: BookingStage;
  venue: string;
  contractTotalAmount: string;
}

function toLocalDateTimeInputValue(timestamp?: number): string {
  if (typeof timestamp !== "number" || Number.isNaN(timestamp)) return "";
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toLocalDateInputValue(timestamp?: number): string {
  return timestampToIsoDate(timestamp) || "";
}

function parseLocalDateTimeInput(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = new Date(trimmed);
  const timestamp = parsed.getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function parseLocalDateInput(value: string): number | undefined {
  return parseDateToTimestamp(value.trim());
}

function endOfDayTimestamp(value?: number): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  date.setHours(23, 59, 0, 0);
  return date.getTime();
}

function hasExplicitEventTimes(snapshot: WorkspaceSnapshot): boolean {
  const rows = snapshot.contract?.dynamicFields.eventDetails || [];
  if (rows.some((row) => Boolean((row.time || "").trim()))) {
    return true;
  }
  const duration = (snapshot.event.duration || "").trim();
  if (!duration) return false;
  return /(\d{1,2}:\d{2}|\d{1,2}\s*(am|pm))/i.test(duration);
}

function workspaceMetaFromSnapshot(snapshot: WorkspaceSnapshot): WorkspaceMetaDraft {
  const contractTotal = snapshot.contract?.dynamicFields.totalAmount || 0;
  const dateOnly = !hasExplicitEventTimes(snapshot);
  const eventRows = snapshot.contract?.dynamicFields.eventDetails || [];
  const contractStartDate = eventRows[0]?.date;
  const contractEndDate = eventRows[eventRows.length - 1]?.date;
  const canonicalStartIso =
    snapshot.event.eventDate ||
    contractStartDate ||
    timestampToIsoDate(snapshot.event.workspaceStartTimestamp) ||
    timestampToIsoDate(snapshot.event.eventDateTimestamp);
  const canonicalEndIso =
    contractEndDate ||
    snapshot.event.eventDate ||
    timestampToIsoDate(snapshot.event.workspaceEndTimestamp) ||
    canonicalStartIso;
  const fallbackStartTs =
    parseDateToTimestamp(canonicalStartIso) ||
    snapshot.event.workspaceStartTimestamp ||
    snapshot.event.eventDateTimestamp ||
    parseDateToTimestamp(contractStartDate);
  const fallbackEndTs =
    endOfDayTimestamp(parseDateToTimestamp(canonicalEndIso) || fallbackStartTs) ||
    snapshot.event.workspaceEndTimestamp ||
    endOfDayTimestamp(snapshot.event.eventDateTimestamp || fallbackStartTs);
  const normalizedEndTs =
    typeof fallbackStartTs === "number" && typeof fallbackEndTs === "number" && fallbackEndTs < fallbackStartTs
      ? endOfDayTimestamp(fallbackStartTs)
      : fallbackEndTs;
  return {
    workspaceStartAt: dateOnly ? toLocalDateInputValue(fallbackStartTs) : toLocalDateTimeInputValue(fallbackStartTs),
    workspaceEndAt: dateOnly ? toLocalDateInputValue(normalizedEndTs) : toLocalDateTimeInputValue(normalizedEndTs),
    dateOnly,
    stage: snapshot.event.stageOverride || snapshot.event.stage,
    venue: snapshot.event.venue || "",
    contractTotalAmount: String(contractTotal),
  };
}

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

type ChecklistProofKind = "signed_contract" | "deposit_proof" | "invoice_proof";

interface ChecklistProofStep {
  kind: ChecklistProofKind;
  title: string;
  description: string;
  expectedAmount?: number;
}

interface ChecklistProofApiResult {
  kind: ChecklistProofKind;
  document?: {
    id: string;
    filename: string;
    mimeType: string;
    uploadedAt: string;
  };
  expectedAmount?: number;
  extractedAmount?: number;
  amountMatched: boolean;
  ocrStatus: "not_needed" | "success" | "manual_required";
  ocrReason?: string;
  validationMessage: string;
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function cancellationFromDueDate(dueDate: string): string | undefined {
  const ts = parseDateToTimestamp(dueDate);
  if (!ts) return undefined;

  const source = new Date(ts);
  const targetYear = source.getFullYear();
  const targetMonthIndex = source.getMonth() - 6;
  const lastDayOfTargetMonth = new Date(targetYear, targetMonthIndex + 1, 0).getDate();
  const targetDay = Math.min(source.getDate(), lastDayOfTargetMonth);
  const shifted = new Date(targetYear, targetMonthIndex, targetDay);
  return timestampToIsoDate(shifted.getTime());
}

function latestContextSnippet(rawFeed: string): string {
  const feed = (rawFeed || "").trim();
  if (!feed) return "";
  const markerMatches = [...feed.matchAll(/-----\s*(New Inquiry|New Context|Workspace Context:[^-]+)\s*-----/g)];
  if (!markerMatches.length) {
    return feed.slice(-600).trim();
  }
  const lastMarker = markerMatches[markerMatches.length - 1];
  const markerStart = lastMarker.index || 0;
  const markerText = lastMarker[0] || "";
  const afterMarker = feed.slice(markerStart + markerText.length).trim();
  if (afterMarker) return afterMarker.slice(0, 600).trim();
  return feed.slice(markerStart).slice(0, 600).trim();
}

export default function WorkspaceEditor({ initial, ocrManualMode }: WorkspaceEditorProps) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState(initial);
  const [profile, setProfile] = useState<WorkspaceProfile>(() => profileFromSnapshot(initial));
  const [workspaceMeta, setWorkspaceMeta] = useState<WorkspaceMetaDraft>(() => workspaceMetaFromSnapshot(initial));
  const [emailDraft, setEmailDraft] = useState(initial.event.latestDraftEmail || "");
  const [notes, setNotes] = useState(initial.event.latestNotes || "");
  const [ocrText, setOcrText] = useState(initial.event.latestOcrText || "");
  const [signedContract, setSignedContract] = useState(
    Boolean(initial.event.signedContract)
  );
  const [initialDepositReceived, setInitialDepositReceived] = useState(
    Boolean(initial.event.initialDepositReceived || initial.event.depositStatus === "received")
  );
  const [fullInvoicePaid, setFullInvoicePaid] = useState(Boolean(initial.invoice?.status === "paid"));
  const [adjustedContractSigned, setAdjustedContractSigned] = useState(Boolean(initial.event.adjustedContractSigned));
  const [additionalDepositCollected, setAdditionalDepositCollected] = useState(
    Boolean(initial.event.additionalDepositCollected)
  );
  const [rawOpen, setRawOpen] = useState(false);
  const [contractFields, setContractFields] = useState<ContractDynamicFields | undefined>(
    initial.contract?.dynamicFields
  );
  const contractPreviewFrameRef = useRef<HTMLIFrameElement | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [pendingChecklistPayload, setPendingChecklistPayload] = useState<Record<string, unknown> | null>(null);
  const [activeProofStep, setActiveProofStep] = useState<ChecklistProofStep | null>(null);
  const [proofUpload, setProofUpload] = useState<File | null>(null);
  const [proofUploading, setProofUploading] = useState(false);
  const [proofStatus, setProofStatus] = useState("");

  const legalBody = snapshot.contract?.legalBody || CONTRACT_LEGAL_BODY;

  const contractPreview = useMemo(() => {
    if (!contractFields) {
      return null;
    }
    return renderContract(contractFields, legalBody, snapshot.client.fullName);
  }, [contractFields, legalBody, snapshot.client.fullName]);

  const previewFields = contractPreview?.normalizedFields;
  const contractTextForActions = contractPreview?.renderedText || snapshot.contract?.renderedText || "";
  const contractHtmlPreview = useMemo(() => {
    if (!previewFields) {
      return "";
    }
    return renderContractHtml({
      clientName: snapshot.client.fullName,
      fields: previewFields,
      legalBody,
    });
  }, [previewFields, snapshot.client.fullName, legalBody]);

  const invoiceHint = useMemo(() => {
    if (!snapshot.invoice) return "";
    return `Invoice total ${formatUsd(snapshot.invoice.amount)}, deposit ${formatUsd(snapshot.invoice.depositAmount)}, remaining ${formatUsd(snapshot.invoice.balanceRemaining)}`;
  }, [snapshot.invoice]);
  const contractTotalAmount = previewFields?.totalAmount || snapshot.contract?.dynamicFields.totalAmount || 0;
  const latestContextPreview = useMemo(() => latestContextSnippet(ocrText), [ocrText]);
  const contextEventDetails = contractFields?.eventDetails || snapshot.contract?.dynamicFields.eventDetails || [];
  const headerPrimaryName = (profile.primaryClientName || snapshot.client.fullName || "Client").trim();
  const headerPrimaryFirstName = headerPrimaryName.split(/\s+/)[0] || "Client";
  const canonicalStartTs =
    parseDateToTimestamp(snapshot.event.eventDate) ||
    snapshot.event.workspaceStartTimestamp ||
    snapshot.event.eventDateTimestamp;
  const titleDate = formatDateLong({
    timestamp: canonicalStartTs,
    isoDate: snapshot.event.eventDate || timestampToIsoDate(snapshot.event.workspaceStartTimestamp),
    fallback: "TBD",
  });
  const workspaceTitle = `${headerPrimaryFirstName}'s ${snapshot.event.eventType || "Event"} on ${titleDate}`;
  const profileContact = preferredContact(profile, snapshot.client);
  const profileBaseline = useMemo(() => profileFromSnapshot(snapshot), [snapshot]);
  const workspaceMetaBaseline = useMemo(() => workspaceMetaFromSnapshot(snapshot), [snapshot]);
  const profileDirty = JSON.stringify(profile) !== JSON.stringify(profileBaseline);
  const workspaceMetaDirty = JSON.stringify(workspaceMeta) !== JSON.stringify(workspaceMetaBaseline);

  const rawDirty = ocrText !== (snapshot.event.latestOcrText || "");
  const needsSummaryGeneration = Boolean((snapshot.event.latestOcrText || "").trim() && !snapshot.event.latestInquirySummary?.trim());
  const canApproveRaw = rawDirty || needsSummaryGeneration;
  const draftDirty = emailDraft !== (snapshot.event.latestDraftEmail || "");
  const notesDirty = notes !== (snapshot.event.latestNotes || "");
  const needsAdjustedContractSignature = Boolean(snapshot.event.needsAdjustedContractSignature);
  const needsAdditionalDepositCollection = Boolean(snapshot.event.needsAdditionalDepositCollection);
  const showAdjustedContractChecklist = needsAdjustedContractSignature || adjustedContractSigned;
  const showAdditionalDepositChecklist = needsAdditionalDepositCollection || additionalDepositCollected;
  const showInvoiceChecklist = signedContract && initialDepositReceived;
  const contractDirty =
    JSON.stringify(contractFields || null) !== JSON.stringify(snapshot.contract?.dynamicFields || null);

  function setRowField(
    rowIndex: number,
    field: "title" | "date" | "time" | "location" | "notes" | "amount" | "manualOverridePrice",
    value: string
  ) {
    if (!contractFields) return;
    setContractFields({
      ...contractFields,
      eventDetails: contractFields.eventDetails.map((row, index) => {
        if (index !== rowIndex) return row;
        if (field === "amount") {
          return { ...row, amount: Number(value || 0) };
        }
        if (field === "manualOverridePrice") {
          const trimmed = value.trim();
          if (!trimmed) {
            return { ...row, manualOverridePrice: undefined };
          }
          const numeric = Number(trimmed);
          return {
            ...row,
            manualOverridePrice: Number.isFinite(numeric) ? numeric : undefined,
          };
        }
        return { ...row, [field]: value };
      }),
    });
  }

  function deleteEventRow(rowIndex: number) {
    if (!contractFields) return;
    const nextRows = contractFields.eventDetails.filter((_, index) => index !== rowIndex);
    if (nextRows.length === contractFields.eventDetails.length) return;
    setContractFields({
      ...contractFields,
      eventDetails: nextRows,
    });
  }

  function currentInvoiceDueAmount(): number | undefined {
    if (snapshot.invoice?.balanceRemaining && snapshot.invoice.balanceRemaining > 0) {
      return snapshot.invoice.balanceRemaining;
    }
    if (snapshot.invoice?.amount && snapshot.invoice.amount > 0) {
      return snapshot.invoice.amount;
    }
    if (typeof contractTotalAmount === "number" && contractTotalAmount > 0) {
      return contractTotalAmount;
    }
    return undefined;
  }

  function resetProofModalState() {
    setPendingChecklistPayload(null);
    setActiveProofStep(null);
    setProofUpload(null);
    setProofUploading(false);
    setProofStatus("");
  }

  function openProofModal(step: ChecklistProofStep, payload: Record<string, unknown>) {
    setPendingChecklistPayload(payload);
    setActiveProofStep(step);
    setProofUpload(null);
    setProofStatus("");
  }

  function checklistProofStep(field: "signedContract" | "initialDepositReceived" | "fullInvoicePaid" | "adjustedContractSigned" | "additionalDepositCollected"): ChecklistProofStep {
    if (field === "signedContract") {
      return {
        kind: "signed_contract",
        title: "Upload Signed Contract",
        description: "Upload the signed contract file so it is stored in this workspace.",
      };
    }
    if (field === "initialDepositReceived") {
      const expected = previewFields?.depositAmount || snapshot.contract?.dynamicFields.depositAmount || 0;
      return {
        kind: "deposit_proof",
        title: "Upload Deposit Proof",
        description: "Upload a screenshot of the initial deposit. OCR will verify it matches the contract deposit amount.",
        expectedAmount: expected > 0 ? expected : undefined,
      };
    }
    if (field === "fullInvoicePaid") {
      return {
        kind: "invoice_proof",
        title: "Upload Remaining Invoice Proof",
        description: "Upload proof of the remaining invoice payment. OCR will verify the amount.",
        expectedAmount: currentInvoiceDueAmount(),
      };
    }
    if (field === "adjustedContractSigned") {
      return {
        kind: "signed_contract",
        title: "Upload Adjusted Signed Contract",
        description: "Upload the adjusted signed contract so this checklist action is documented.",
      };
    }
    return {
      kind: "deposit_proof",
      title: "Upload Additional Deposit Proof",
      description: "Upload proof of the additional deposit for the adjusted contract terms.",
      expectedAmount:
        typeof snapshot.event.additionalDepositAmountDue === "number" && snapshot.event.additionalDepositAmountDue > 0
          ? snapshot.event.additionalDepositAmountDue
          : undefined,
    };
  }

  async function patch(payload: Record<string, unknown>, message: string) {
    setSaving(true);
    setStatus("");
    try {
      const response = await fetch(`/api/admin/workspace/${snapshot.event.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) {
        setStatus(data.error || "Update failed.");
        return;
      }
      setSnapshot(data as WorkspaceSnapshot);
      setProfile(profileFromSnapshot(data as WorkspaceSnapshot));
      setWorkspaceMeta(workspaceMetaFromSnapshot(data as WorkspaceSnapshot));
      setEmailDraft(data.event.latestDraftEmail || "");
      setNotes(data.event.latestNotes || "");
      setOcrText(data.event.latestOcrText || "");
      setSignedContract(Boolean(data.event.signedContract));
      setInitialDepositReceived(Boolean(data.event.initialDepositReceived || data.event.depositStatus === "received"));
      setFullInvoicePaid(Boolean(data.invoice?.status === "paid"));
      setAdjustedContractSigned(Boolean(data.event.adjustedContractSigned));
      setAdditionalDepositCollected(Boolean(data.event.additionalDepositCollected));
      setContractFields(data.contract?.dynamicFields);
      setStatus(message);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Update failed.");
    } finally {
      setSaving(false);
    }
  }

  async function approveRawSection() {
    await patch({ ocrText, reanalyzeFromRaw: true }, "Raw context feed approved. Summary, draft, and contract refreshed.");
  }

  function cancelRawSection() {
    setOcrText(snapshot.event.latestOcrText || "");
    setStatus("Raw context feed edits cancelled.");
  }

  async function approveDraftSection() {
    const payload = draftDirty ? { emailDraft, approveDraftEmail: true } : { approveDraftEmail: true };
    await patch(payload, "Draft response approved");
  }

  async function regenerateDraftSection() {
    await patch({ regenerateDraftEmail: true }, "Draft response regenerated from current context.");
  }

  function cancelDraftSection() {
    setEmailDraft(snapshot.event.latestDraftEmail || "");
    setStatus("Draft response edits cancelled.");
  }

  async function approveContractSection() {
    if (!contractFields) return;
    const payload = contractDirty
      ? { contractFields, approveContractFields: true }
      : { approveContractFields: true };
    await patch(payload, "Contract dynamic fields approved");
  }

  async function regenerateContractSection() {
    await patch({ reanalyzeFromRaw: true }, "Contract dynamic fields regenerated from raw context.");
  }

  function cancelContractSection() {
    setContractFields(snapshot.contract?.dynamicFields);
    setStatus("Contract field edits cancelled.");
  }

  async function approveNotesSection() {
    await patch({ notes }, "Notes approved");
  }

  function cancelNotesSection() {
    setNotes(snapshot.event.latestNotes || "");
    setStatus("Note edits cancelled.");
  }

  function setProfileField<K extends keyof WorkspaceProfile>(key: K, value: WorkspaceProfile[K]) {
    setProfile((prev) => ({
      ...prev,
      [key]: value,
    }));
  }

  async function approveProfileSection() {
    await patch({ profile }, "Profile updated");
  }

  function cancelProfileSection() {
    setProfile(profileBaseline);
    setStatus("Profile edits cancelled.");
  }

  function setWorkspaceMetaField<K extends keyof WorkspaceMetaDraft>(key: K, value: WorkspaceMetaDraft[K]) {
    setWorkspaceMeta((prev) => ({
      ...prev,
      [key]: value,
    }));
  }

  async function approveWorkspaceMetaSection() {
    const rawStartTs = workspaceMeta.dateOnly
      ? parseLocalDateInput(workspaceMeta.workspaceStartAt)
      : parseLocalDateTimeInput(workspaceMeta.workspaceStartAt);
    const rawEndTs = workspaceMeta.dateOnly
      ? endOfDayTimestamp(parseLocalDateInput(workspaceMeta.workspaceEndAt || workspaceMeta.workspaceStartAt))
      : parseLocalDateTimeInput(workspaceMeta.workspaceEndAt);
    const startTs = rawStartTs;
    const endTs =
      typeof rawStartTs === "number" && typeof rawEndTs === "number" && rawEndTs < rawStartTs
        ? endOfDayTimestamp(rawStartTs)
        : rawEndTs;
    const total = Number(workspaceMeta.contractTotalAmount);
    await patch(
      {
        workspaceMeta: {
          workspaceStartTimestamp: typeof startTs === "number" ? startTs : null,
          workspaceEndTimestamp: typeof endTs === "number" ? endTs : null,
          stage: workspaceMeta.stage,
          venue: workspaceMeta.venue,
          contractTotalAmount: Number.isFinite(total) ? total : null,
        },
      },
      "Workspace profile updated"
    );
  }

  function cancelWorkspaceMetaSection() {
    setWorkspaceMeta(workspaceMetaBaseline);
    setStatus("Workspace profile edits cancelled.");
  }

  async function toggleChecklistField(
    field: "signedContract" | "initialDepositReceived" | "fullInvoicePaid" | "adjustedContractSigned" | "additionalDepositCollected",
    checked: boolean
  ) {
    if (!checked) {
      await patch(
        {
          [field]: false,
        },
        `${field.replace(/([A-Z])/g, " $1").trim()} unchecked`
      );
      return;
    }

    const payload: Record<string, unknown> = {
      [field]: true,
    };
    if (field === "fullInvoicePaid" && (!signedContract || !initialDepositReceived)) {
      setStatus("Mark signed contract and initial deposit first.");
      return;
    }
    openProofModal(checklistProofStep(field), payload);
  }

  function cancelProofModal() {
    resetProofModalState();
    setStatus("Checklist approval cancelled.");
  }

  async function uploadChecklistProofAndContinue() {
    if (!activeProofStep || !proofUpload) {
      setProofStatus("Select a file before uploading.");
      return;
    }

    setProofUploading(true);
    setProofStatus("");
    try {
      const formData = new FormData();
      formData.set("kind", activeProofStep.kind);
      formData.set("upload", proofUpload);

      const response = await fetch(`/api/admin/workspace/${snapshot.event.id}/checklist-proof`, {
        method: "POST",
        body: formData,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setProofStatus(payload.error || "Failed to upload proof.");
        return;
      }

      const result = payload.result as ChecklistProofApiResult | undefined;
      if (!result) {
        setProofStatus("Proof upload response was empty.");
        return;
      }

      const doc = result.document;
      if (doc) {
        setSnapshot((previous) => ({
          ...previous,
          documents: [
            ...previous.documents,
            {
              id: doc.id,
              clientId: previous.client.id,
              eventId: previous.event.id,
              filename: doc.filename,
              storedPath: "",
              mimeType: doc.mimeType,
              sizeBytes: 0,
              uploadedAt: doc.uploadedAt,
            },
          ],
        }));
      }

      if (activeProofStep.kind !== "signed_contract" && !result.amountMatched) {
        const expected = typeof result.expectedAmount === "number" ? formatUsd(result.expectedAmount) : "unknown";
        const extracted = typeof result.extractedAmount === "number" ? formatUsd(result.extractedAmount) : "none detected";
        const extra = result.ocrReason ? ` ${result.ocrReason}` : "";
        setProofStatus(`Amount mismatch. Expected ${expected}; OCR found ${extracted}.${extra}`);
        return;
      }

      const finalPayload = pendingChecklistPayload;
      resetProofModalState();
      if (finalPayload) {
        await patch(
          finalPayload,
          activeProofStep.kind === "signed_contract"
            ? "Signed contract proof verified."
            : result.validationMessage || "Checklist proof verified."
        );
      }
    } catch (error) {
      setProofStatus(error instanceof Error ? error.message : "Failed to upload proof.");
    } finally {
      setProofUploading(false);
    }
  }

  async function approveContract() {
    await patch({ emailDraft, notes, ocrText, contractFields, approveContract: true }, "Contract approved");
  }

  async function deleteEventWorkspace() {
    const confirmed = window.confirm("Delete this workspace and all related inquiry/contract/invoice context?");
    if (!confirmed) return;

    setSaving(true);
    setStatus("");
    try {
      const response = await fetch(`/api/admin/workspace/${snapshot.event.id}`, {
        method: "DELETE",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setStatus(payload.error || "Failed to delete workspace.");
        return;
      }
      router.push("/admin/workspaces");
      router.refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to delete workspace.");
    } finally {
      setSaving(false);
    }
  }

  async function copyContractText() {
    await navigator.clipboard.writeText(contractTextForActions || "");
    setStatus("Contract text copied");
  }

  async function copyDraftText() {
    const text = (emailDraft || "").trim();
    if (!text) {
      setStatus("No draft response text to copy.");
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      setStatus("Draft response copied");
    } catch {
      setStatus("Failed to copy draft response.");
    }
  }

  function exportPdf() {
    if (!previewFields) {
      setStatus("No contract fields available to export.");
      return;
    }

    const frameWindow = contractPreviewFrameRef.current?.contentWindow;
    if (!frameWindow) {
      setStatus("Contract preview not ready yet. Try again in a moment.");
      return;
    }

    frameWindow.focus();
    frameWindow.print();
    setStatus("Opened print dialog. Save as PDF to export.");
  }

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-white/15 bg-white/5 p-5 shadow-sm backdrop-blur">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">{workspaceTitle}</h2>
            <p className="text-sm text-slate-300">{headerPrimaryName} · {profileContact}</p>
          </div>
          <StageBadge stage={snapshot.event.stage} />
        </div>

        <div className="mb-4 rounded-lg border border-white/10 bg-black/20 p-3">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Primary Contact</h3>
            <p className="text-xs text-slate-300">Editable source of truth for workspace contact.</p>
          </div>
          <div className="grid gap-2 md:grid-cols-4">
            <label className="text-[11px] font-medium text-slate-300">
              Primary Client Name
              <input
                value={profile.primaryClientName}
                onChange={(event) => setProfileField("primaryClientName", event.target.value)}
                className="mt-1 w-full rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
              />
            </label>
            <label className="text-[11px] font-medium text-slate-300">
              Email
              <input
                value={profile.primaryEmail}
                onChange={(event) => setProfileField("primaryEmail", event.target.value)}
                className="mt-1 w-full rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
              />
            </label>
            <label className="text-[11px] font-medium text-slate-300">
              Phone Number
              <input
                value={profile.primaryPhone}
                onChange={(event) => setProfileField("primaryPhone", event.target.value)}
                className="mt-1 w-full rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
              />
            </label>
            <label className="text-[11px] font-medium text-slate-300">
              Instagram Handle
              <input
                value={profile.primaryInstagramHandle}
                onChange={(event) => setProfileField("primaryInstagramHandle", event.target.value)}
                className="mt-1 w-full rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
              />
            </label>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button
              onClick={cancelProfileSection}
              disabled={!profileDirty || saving}
              className="rounded border border-white/20 px-3 py-1 text-xs text-slate-100 disabled:opacity-50"
            >
              X Cancel
            </button>
            <button
              onClick={approveProfileSection}
              disabled={!profileDirty || saving}
              className="rounded bg-blue-600 px-3 py-1 text-xs text-white disabled:opacity-50"
            >
              ✓ Save
            </button>
          </div>
        </div>

        <div className="rounded-lg border border-white/10 bg-black/20 p-3">
          <h3 className="mb-2 text-sm font-semibold text-white">Workspace Profile</h3>
          <div className="grid gap-2 md:grid-cols-4">
            <label className="text-[11px] font-medium text-slate-300">
              {workspaceMeta.dateOnly ? "Start Date" : "Start (Date/Time)"}
              <input
                type={workspaceMeta.dateOnly ? "date" : "datetime-local"}
                value={workspaceMeta.workspaceStartAt}
                onChange={(event) => setWorkspaceMetaField("workspaceStartAt", event.target.value)}
                className="mt-1 w-full rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
              />
            </label>
            <label className="text-[11px] font-medium text-slate-300">
              {workspaceMeta.dateOnly ? "End Date" : "End (Date/Time)"}
              <input
                type={workspaceMeta.dateOnly ? "date" : "datetime-local"}
                value={workspaceMeta.workspaceEndAt}
                onChange={(event) => setWorkspaceMetaField("workspaceEndAt", event.target.value)}
                className="mt-1 w-full rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
              />
            </label>
            <label className="text-[11px] font-medium text-slate-300">
              Stage
              <select
                value={workspaceMeta.stage}
                onChange={(event) => setWorkspaceMetaField("stage", event.target.value as BookingStage)}
                className="mt-1 w-full rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
              >
                <option value="inquiry">Inquiry</option>
                <option value="in_contract">In Contract</option>
                <option value="execution">Execution</option>
                <option value="cancelled">Cancelled</option>
                <option value="completed">Complete</option>
              </select>
            </label>
            <label className="text-[11px] font-medium text-slate-300">
              Venue
              <input
                value={workspaceMeta.venue}
                onChange={(event) => setWorkspaceMetaField("venue", event.target.value)}
                className="mt-1 w-full rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
              />
            </label>
            <label className="text-[11px] font-medium text-slate-300">
              Contract Total (USD)
              <div className="relative mt-1">
                <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-slate-400">$</span>
                <input
                  type="number"
                  value={workspaceMeta.contractTotalAmount}
                  onChange={(event) => setWorkspaceMetaField("contractTotalAmount", event.target.value)}
                  className="w-full rounded border border-white/20 bg-slate-900 py-1 pl-5 pr-2 text-xs text-white"
                />
              </div>
            </label>
          </div>
          <div className="mt-3 rounded border border-white/10 bg-black/20 p-2">
            <p className="mb-1 text-[11px] font-medium text-slate-300">Documents</p>
            {snapshot.documents.length ? (
              <ul className="space-y-1 text-xs text-slate-200">
                {snapshot.documents.map((doc) => (
                  <li key={doc.id}>
                    <a
                      href={`/api/admin/documents/${doc.id}`}
                      className="underline decoration-slate-500 underline-offset-2 hover:text-white"
                    >
                      {doc.filename}
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-slate-400">No documents uploaded yet.</p>
            )}
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button
              onClick={cancelWorkspaceMetaSection}
              disabled={!workspaceMetaDirty || saving}
              className="rounded border border-white/20 px-3 py-1 text-xs text-slate-100 disabled:opacity-50"
            >
              X Cancel
            </button>
            <button
              onClick={approveWorkspaceMetaSection}
              disabled={!workspaceMetaDirty || saving}
              className="rounded bg-blue-600 px-3 py-1 text-xs text-white disabled:opacity-50"
            >
              ✓ Save
            </button>
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-white/10 bg-black/20 p-3">
          <h3 className="mb-2 text-sm font-semibold text-white">Context summary</h3>
          <p className="rounded border border-white/10 bg-black/20 p-3 text-sm text-slate-200">
            {snapshot.event.latestInquirySummary || "No summary yet. Approve raw context edits to generate a summary."}
          </p>
          <div className="mt-3 rounded border border-white/10 bg-black/20 p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-300">Event details from context</p>
            {contextEventDetails.length ? (
              <ul className="space-y-2 text-xs text-slate-200">
                {contextEventDetails.map((row, index) => (
                  <li key={`${row.id}-${index}`} className="rounded border border-white/10 bg-black/20 px-2 py-2">
                    <p className="font-semibold text-white">{row.title || `Event ${index + 1}`}</p>
                    <p>
                      {(row.date || "-")} · {(row.time || "-")}
                    </p>
                    <p>{row.location || "-"}</p>
                    <p className="text-slate-300">{row.notes || "No notes yet."}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-slate-400">No inferred event details yet.</p>
            )}
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-white/10 bg-black/20 p-3">
          <p className="mb-2 text-sm font-semibold text-white">Stage checklist</p>
          <div className="space-y-2 text-sm text-slate-200">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={signedContract}
                disabled={saving || proofUploading}
                onChange={(event) => void toggleChecklistField("signedContract", event.target.checked)}
              />
              <span className={signedContract ? "line-through text-slate-400" : ""}>Signed Contract</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={initialDepositReceived}
                disabled={saving || proofUploading}
                onChange={(event) => void toggleChecklistField("initialDepositReceived", event.target.checked)}
              />
              <span className={initialDepositReceived ? "line-through text-slate-400" : ""}>Initial Deposit Received</span>
            </label>
            {showAdjustedContractChecklist ? (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={adjustedContractSigned}
                  disabled={saving || proofUploading}
                  onChange={(event) => void toggleChecklistField("adjustedContractSigned", event.target.checked)}
                />
                <span className={adjustedContractSigned ? "line-through text-slate-400" : ""}>Sign Adjusted Contract</span>
              </label>
            ) : null}
            {showAdditionalDepositChecklist ? (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={additionalDepositCollected}
                  disabled={saving || proofUploading}
                  onChange={(event) => void toggleChecklistField("additionalDepositCollected", event.target.checked)}
                />
                <span className={additionalDepositCollected ? "line-through text-slate-400" : ""}>Collect Additional Deposit</span>
                {typeof snapshot.event.additionalDepositAmountDue === "number" && snapshot.event.additionalDepositAmountDue > 0 ? (
                  <span className="text-xs text-slate-400">
                    ({formatUsd(snapshot.event.additionalDepositAmountDue)})
                  </span>
                ) : null}
              </label>
            ) : null}
            {showInvoiceChecklist ? (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={fullInvoicePaid}
                  disabled={saving || proofUploading}
                  onChange={(event) => void toggleChecklistField("fullInvoicePaid", event.target.checked)}
                />
                <span className={fullInvoicePaid ? "line-through text-slate-400" : ""}>Remaining Invoice Received</span>
              </label>
            ) : null}
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-white/10 bg-black/20 p-3">
          <p className="mb-2 text-sm font-semibold text-white">Documents</p>
          {snapshot.documents.length ? (
            <ul className="space-y-1 text-sm text-slate-200">
              {snapshot.documents.map((doc) => (
                <li key={doc.id}>
                  <a
                    href={`/api/admin/documents/${doc.id}`}
                    className="underline decoration-slate-500 underline-offset-2 hover:text-white"
                  >
                    {doc.filename}
                  </a>{" "}
                  · {doc.mimeType}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-400">No documents uploaded yet.</p>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-white/15 bg-white/5 p-5 shadow-sm backdrop-blur">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h4 className="text-sm font-semibold text-white">Raw context feed (editable)</h4>
          <button
            onClick={() => setRawOpen((prev) => !prev)}
            className="rounded border border-white/20 px-2 py-1 text-xs text-slate-100"
          >
            {rawOpen ? "Collapse Raw Context" : "Expand Raw Context"}
          </button>
        </div>
        <p className="mb-2 text-xs text-slate-300">
          New context entries append to this feed. Approving edits re-runs extraction, summary generation, contract field updates, and draft response generation.
        </p>
        {ocrManualMode ? (
          <p className="mb-2 rounded border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            OCR placeholder could not auto-extract full text. Edit this text manually before saving.
          </p>
        ) : null}

        {rawOpen ? (
          <>
            <textarea
              value={ocrText}
              onChange={(event) => setOcrText(event.target.value)}
              className="h-96 w-full rounded-md border border-white/20 bg-slate-900 p-3 text-sm text-white"
            />
            {rawDirty ? <p className="mt-2 text-xs text-amber-300">Pending raw feed edits</p> : null}
            {!rawDirty && needsSummaryGeneration ? (
              <p className="mt-2 text-xs text-amber-300">Summary is missing. Approve to regenerate from current raw feed.</p>
            ) : null}
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={cancelRawSection}
                disabled={!rawDirty || saving}
                className="rounded border border-white/20 px-3 py-2 text-sm text-slate-100 disabled:opacity-50"
              >
                X Cancel
              </button>
              <button
                onClick={approveRawSection}
                disabled={!canApproveRaw || saving}
                className="rounded bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-50"
              >
                ✓ Approve
              </button>
            </div>
          </>
        ) : (
          <div className="space-y-2 rounded border border-white/10 bg-black/20 px-3 py-2">
            <p className="text-xs text-slate-400">Raw context is collapsed by default.</p>
            <p className="text-xs text-slate-300">
              <span className="font-medium text-slate-200">Last Context:</span>{" "}
              {latestContextPreview || "No context yet."}
            </p>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-white/15 bg-white/5 p-5 shadow-sm backdrop-blur">
        <h3 className="mb-2 text-sm font-semibold text-white">Draft response</h3>
        <textarea
          value={emailDraft}
          onChange={(event) => setEmailDraft(event.target.value)}
          className="h-40 w-full rounded-md border border-white/20 bg-slate-900 p-3 text-sm text-white"
        />
        {draftDirty ? <p className="mt-2 text-xs text-amber-300">Pending draft response edits</p> : null}
        {!draftDirty ? (
          <p className="mt-2 text-xs text-slate-300">Approve to mark this generated draft response as training data.</p>
        ) : null}
        <div className="mt-3 flex justify-end gap-2">
          <button
            onClick={cancelDraftSection}
            disabled={!draftDirty || saving}
            className="rounded border border-white/20 px-3 py-2 text-sm text-slate-100 disabled:opacity-50"
          >
            X Cancel
          </button>
          <button
            onClick={copyDraftText}
            disabled={saving || !emailDraft.trim()}
            className="rounded border border-white/20 px-3 py-2 text-sm text-slate-100 disabled:opacity-50"
          >
            Copy text
          </button>
          <button
            onClick={regenerateDraftSection}
            disabled={saving}
            className="rounded border border-white/20 px-3 py-2 text-sm text-slate-100 disabled:opacity-50"
          >
            Regenerate
          </button>
          <button
            onClick={approveDraftSection}
            disabled={saving || !emailDraft.trim()}
            className="rounded bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-50"
          >
            ✓ Approve
          </button>
        </div>
      </section>

      {contractFields ? (
        <section className="rounded-xl border border-white/15 bg-white/5 p-5 shadow-sm backdrop-blur">
          <h3 className="mb-3 text-sm font-semibold text-white">Contract dynamic fields</h3>
          <div className="space-y-4">
            {contractFields.eventDetails.map((row, index) => (
              <fieldset key={`${row.id}-${index}`} className="rounded border border-white/10 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="px-1 text-xs font-semibold text-slate-200">Event Row {index + 1}</p>
                  <button
                    type="button"
                    onClick={() => deleteEventRow(index)}
                    disabled={saving}
                    className="rounded border border-rose-400/40 px-2 py-1 text-xs text-rose-100 hover:bg-rose-500/20 disabled:opacity-50"
                  >
                    Delete event row
                  </button>
                </div>
                <div className="grid gap-3 md:grid-cols-6">
                  <label className="text-xs font-medium text-slate-300">
                    Event Name
                    <input
                      value={row.title}
                      onChange={(e) => setRowField(index, "title", e.target.value)}
                      className="mt-1 w-full rounded border border-white/20 bg-slate-900 px-2 py-1 text-sm text-white"
                    />
                  </label>
                  <label className="text-xs font-medium text-slate-300">
                    Date
                    <input
                      value={row.date}
                      onChange={(e) => setRowField(index, "date", e.target.value)}
                      className="mt-1 w-full rounded border border-white/20 bg-slate-900 px-2 py-1 text-sm text-white"
                    />
                  </label>
                  <label className="text-xs font-medium text-slate-300">
                    Time
                    <input
                      value={row.time}
                      onChange={(e) => setRowField(index, "time", e.target.value)}
                      className="mt-1 w-full rounded border border-white/20 bg-slate-900 px-2 py-1 text-sm text-white"
                    />
                  </label>
                  <label className="text-xs font-medium text-slate-300">
                    Location
                    <input
                      value={row.location}
                      onChange={(e) => setRowField(index, "location", e.target.value)}
                      className="mt-1 w-full rounded border border-white/20 bg-slate-900 px-2 py-1 text-sm text-white"
                    />
                  </label>
                  <label className="text-xs font-medium text-slate-300">
                    Per-Event Cost Auto (USD)
                    <div className="relative mt-1">
                      <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-slate-400">$</span>
                      <input
                        value={row.amount}
                        type="number"
                        onChange={(e) => setRowField(index, "amount", e.target.value)}
                        className="w-full rounded border border-white/20 bg-slate-900 py-1 pl-5 pr-2 text-sm text-white"
                      />
                    </div>
                  </label>
                  <label className="text-xs font-medium text-slate-300">
                    Manual Override (USD)
                    <div className="relative mt-1">
                      <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-slate-400">$</span>
                      <input
                        value={typeof row.manualOverridePrice === "number" ? row.manualOverridePrice : ""}
                        type="number"
                        onChange={(e) => setRowField(index, "manualOverridePrice", e.target.value)}
                        className="w-full rounded border border-white/20 bg-slate-900 py-1 pl-5 pr-2 text-sm text-white"
                      />
                    </div>
                  </label>
                </div>
                <label className="mt-3 block text-xs font-medium text-slate-300">
                  Event Notes / Vibe
                  <input
                    value={row.notes || ""}
                    onChange={(e) => setRowField(index, "notes", e.target.value)}
                    className="mt-1 w-full rounded border border-white/20 bg-slate-900 px-2 py-1 text-sm text-white"
                  />
                </label>
              </fieldset>
            ))}
            <div className="grid gap-3 md:grid-cols-3">
              <label className="text-xs font-medium text-slate-300">
                Travel / Accommodation Amount (USD)
                <div className="relative mt-1">
                  <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-slate-400">$</span>
                  <input
                    type="number"
                    value={contractFields.travelAmount}
                    onChange={(e) =>
                      setContractFields({ ...contractFields, travelAmount: Number(e.target.value || 0) })
                    }
                    className="w-full rounded border border-white/20 bg-slate-900 py-1 pl-5 pr-2 text-sm text-white"
                  />
                </div>
              </label>
              <label className="text-xs font-medium text-slate-300">
                Final Payment Due Date
                <input
                  value={contractFields.dueDate}
                  onChange={(e) =>
                    setContractFields({
                      ...contractFields,
                      dueDate: e.target.value,
                      cancellationDate: cancellationFromDueDate(e.target.value) || contractFields.cancellationDate,
                    })
                  }
                  className="mt-1 w-full rounded border border-white/20 bg-slate-900 px-2 py-1 text-sm text-white"
                />
              </label>
              <label className="text-xs font-medium text-slate-300">
                Cancellation Deadline Date
                <input
                  value={contractFields.cancellationDate}
                  onChange={(e) =>
                    setContractFields({ ...contractFields, cancellationDate: e.target.value })
                  }
                  className="mt-1 w-full rounded border border-white/20 bg-slate-900 px-2 py-1 text-sm text-white"
                />
              </label>
            </div>
            {contractDirty ? <p className="text-xs text-amber-300">Pending contract field edits</p> : null}
            {!contractDirty ? (
              <p className="text-xs text-slate-300">Approve to mark the current generated contract as training data.</p>
            ) : null}
            <div className="flex justify-end gap-2">
              <button
                onClick={cancelContractSection}
                disabled={!contractDirty || saving}
                className="rounded border border-white/20 px-3 py-2 text-sm text-slate-100 disabled:opacity-50"
              >
                X Cancel
              </button>
              <button
                onClick={regenerateContractSection}
                disabled={saving}
                className="rounded border border-white/20 px-3 py-2 text-sm text-slate-100 disabled:opacity-50"
              >
                Regenerate
              </button>
              <button
                onClick={approveContractSection}
                disabled={saving}
                className="rounded bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-50"
              >
                ✓ Approve
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {previewFields ? (
        <section className="rounded-xl border border-white/15 bg-white/5 p-5 shadow-sm backdrop-blur">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-white">Contract Document Preview</h3>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={copyContractText}
                className="rounded border border-white/20 px-3 py-2 text-sm text-slate-100"
              >
                Copy Contract Text
              </button>
              <button
                onClick={exportPdf}
                className="rounded border border-white/20 px-3 py-2 text-sm text-slate-100"
              >
                Export PDF
              </button>
              <button
                onClick={() =>
                  downloadText(`contract_${snapshot.event.id}.txt`, contractTextForActions)
                }
                className="rounded border border-white/20 px-3 py-2 text-sm text-slate-100"
              >
                Download Contract Text
              </button>
            </div>
          </div>

          <div className="overflow-hidden rounded border border-gray-200 bg-white">
            <iframe
              ref={contractPreviewFrameRef}
              title="Contract Preview"
              className="h-[980px] w-full"
              srcDoc={contractHtmlPreview}
            />
          </div>
        </section>
      ) : null}

      <section className="rounded-xl border border-white/15 bg-white/5 p-5 shadow-sm backdrop-blur">
        <h3 className="mb-2 text-sm font-semibold text-white">Invoice summary</h3>
        <p className="text-sm text-slate-200">{invoiceHint || "Invoice will appear after contract generation."}</p>
        {snapshot.event.amendmentSuggestion ? (
          <pre className="mt-3 whitespace-pre-wrap rounded border border-blue-400/30 bg-blue-500/10 p-3 text-xs text-blue-100">
            {snapshot.event.amendmentSuggestion}
          </pre>
        ) : null}
      </section>

      <section className="rounded-xl border border-white/15 bg-white/5 p-5 shadow-sm backdrop-blur">
        <h3 className="mb-2 text-sm font-semibold text-white">Internal notes</h3>
        <textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          className="h-28 w-full rounded-md border border-white/20 bg-slate-900 p-3 text-sm text-white"
        />
        {notesDirty ? <p className="mt-2 text-xs text-amber-300">Pending note edits</p> : null}
        <div className="mt-3 flex justify-end gap-2">
          <button
            onClick={cancelNotesSection}
            disabled={!notesDirty || saving}
            className="rounded border border-white/20 px-3 py-2 text-sm text-slate-100 disabled:opacity-50"
          >
            X Cancel
          </button>
          <button
            onClick={approveNotesSection}
            disabled={!notesDirty || saving}
            className="rounded bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-50"
          >
            ✓ Approve
          </button>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <button
          disabled={saving}
          onClick={approveContract}
          className="rounded border border-white/20 px-3 py-2 text-sm text-slate-100 disabled:opacity-50"
        >
          Approve contract
        </button>
        <button
          disabled={saving}
          onClick={deleteEventWorkspace}
          className="rounded border border-rose-400/40 px-3 py-2 text-sm text-rose-100 hover:bg-rose-500/20 disabled:opacity-50"
        >
          Delete workspace
        </button>
      </div>

      {activeProofStep ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-lg rounded-xl border border-white/15 bg-slate-950 p-5 shadow-xl">
            <h3 className="text-base font-semibold text-white">{activeProofStep.title}</h3>
            <p className="mt-2 text-sm text-slate-300">{activeProofStep.description}</p>
            {typeof activeProofStep.expectedAmount === "number" ? (
              <p className="mt-2 text-sm text-blue-200">Expected amount: {formatUsd(activeProofStep.expectedAmount)}</p>
            ) : null}

            <div className="mt-4">
              <label className="mb-1 block text-xs font-medium text-slate-300">Upload File</label>
              <input
                type="file"
                accept={activeProofStep.kind === "signed_contract" ? ".pdf,.doc,.docx,.txt,.jpg,.jpeg,.png" : ".txt,.jpg,.jpeg,.png,.webp"}
                onChange={(event) => setProofUpload(event.target.files?.[0] || null)}
                className="block w-full text-sm text-slate-200"
              />
            </div>

            {proofStatus ? <p className="mt-3 text-sm text-amber-200">{proofStatus}</p> : null}

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={cancelProofModal}
                disabled={proofUploading}
                className="rounded border border-white/20 px-3 py-2 text-sm text-slate-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={uploadChecklistProofAndContinue}
                disabled={proofUploading || !proofUpload}
                className="rounded bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-50"
              >
                {proofUploading ? "Uploading..." : "Upload & Continue"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {status ? <p className="text-sm text-slate-200">{status}</p> : null}
    </div>
  );
}
