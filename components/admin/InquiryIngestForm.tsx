"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { extractInquiryFromText } from "@/lib/admin/inquiries/extract";
import { parseJsonResponseSafe } from "@/lib/admin/http/json-response";
import { formatDateLong } from "@/lib/admin/utils/date";

type StepKey = "validate" | "upload" | "extract" | "match" | "persist" | "redirect";
type StepStatus = "pending" | "active" | "done" | "error";

const STEP_ORDER: Array<{ key: StepKey; label: string }> = [
  { key: "validate", label: "Validate context payload" },
  { key: "upload", label: "Upload text/document payload" },
  { key: "extract", label: "Run OCR/extraction" },
  { key: "match", label: "Match existing workspace" },
  { key: "persist", label: "Save records + build workspace" },
  { key: "redirect", label: "Open workspace" },
];

function makeInitialSteps(): Record<StepKey, StepStatus> {
  return {
    validate: "pending",
    upload: "pending",
    extract: "pending",
    match: "pending",
    persist: "pending",
    redirect: "pending",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface WorkspaceOption {
  eventId: string;
  label: string;
  contact?: string;
}

interface InquiryIngestFormProps {
  workspaceOptions?: WorkspaceOption[];
}

export default function InquiryIngestForm({ workspaceOptions = [] }: InquiryIngestFormProps) {
  const router = useRouter();
  const [messageText, setMessageText] = useState("");
  const [upload, setUpload] = useState<File | null>(null);
  const [workspaceEventId, setWorkspaceEventId] = useState("");
  const [manualEmail, setManualEmail] = useState("");
  const [manualPhone, setManualPhone] = useState("");
  const [manualInstagramHandle, setManualInstagramHandle] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [processingNote, setProcessingNote] = useState("");
  const [steps, setSteps] = useState<Record<StepKey, StepStatus>>(makeInitialSteps());
  const [showProcessing, setShowProcessing] = useState(false);

  const extractedPreview = useMemo(() => {
    if (!messageText.trim()) {
      return null;
    }
    return extractInquiryFromText(messageText);
  }, [messageText]);

  function setStep(step: StepKey, status: StepStatus) {
    setSteps((prev) => ({ ...prev, [step]: status }));
  }

  function resetProcessingState() {
    setSteps(makeInitialSteps());
    setProcessingNote("");
    setShowProcessing(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    resetProcessingState();
    const formElement = e.currentTarget as HTMLFormElement;
    const nativeFormData = new FormData(formElement);
    const selectedWorkspaceEventId = (nativeFormData.get("workspaceEventId")?.toString() || "").trim();

    setStep("validate", "active");
    setProcessingNote("Validating context payload before processing.");

    if (!messageText.trim() && !upload) {
      setStep("validate", "error");
      setError("Provide inquiry text or upload a file.");
      return;
    }

    await sleep(120);
    setStep("validate", "done");

    setLoading(true);
    try {
      const formData = new FormData();
      const encodedMessageText = selectedWorkspaceEventId
        ? `[[WORKSPACE_EVENT_ID:${selectedWorkspaceEventId}]]\n${messageText}`.trim()
        : messageText;
      formData.set("messageText", encodedMessageText);
      if (selectedWorkspaceEventId) {
        formData.set("workspaceEventId", selectedWorkspaceEventId);
      }
      if (manualEmail.trim()) {
        formData.set("manualEmail", manualEmail.trim());
      }
      if (manualPhone.trim()) {
        formData.set("manualPhone", manualPhone.trim());
      }
      if (manualInstagramHandle.trim()) {
        formData.set("manualInstagramHandle", manualInstagramHandle.trim());
      }
      if (upload) {
        formData.set("upload", upload);
      } else {
        const uploadField = nativeFormData.get("upload");
        if (uploadField instanceof File && uploadField.size > 0) {
          formData.set("upload", uploadField);
        }
      }

      setStep("upload", "active");
      setProcessingNote(upload ? `Uploading ${upload.name}` : "Sending context text payload");
      await sleep(120);
      setStep("upload", "done");

      setStep("extract", "active");
      setProcessingNote("Running OCR/extraction and parsing context fields.");

      const response = await fetch("/api/admin/inquiry/ingest", {
        method: "POST",
        body: formData,
      });
      const parsed = await parseJsonResponseSafe<{
        eventId?: string;
        clientId?: string;
        ocrStatus?: "not_needed" | "success" | "manual_required";
        ocrReason?: string;
        error?: string;
      }>(response);
      const payload = parsed.data || {};

      if (!response.ok) {
        setStep("extract", "error");
        setError(payload.error || parsed.error || `Failed to process context (${response.status}).`);
        return;
      }

      if (!payload.eventId) {
        setStep("extract", "error");
        setError(payload.error || parsed.error || "Context processed but no workspace event was returned.");
        return;
      }

      setStep("extract", "done");

      setStep("match", "active");
      setProcessingNote(
        selectedWorkspaceEventId
          ? "Appending context to selected workspace."
          : "Matching context to existing client/event workspace."
      );
      await sleep(120);
      setStep("match", "done");

      setStep("persist", "active");
      setProcessingNote("Saving profile, contract/invoice context, and memory updates.");
      await sleep(120);
      setStep("persist", "done");

      setStep("redirect", "active");
      setProcessingNote("Opening workspace.");

      const query = new URLSearchParams();
      if (payload.ocrStatus === "manual_required") {
        query.set("ocr", "manual");
      }
      router.push(`/admin/workspace/${payload.eventId}${query.toString() ? `?${query.toString()}` : ""}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error.");
    } finally {
      setLoading(false);
    }
  }

  const hasInput = Boolean(messageText.trim() || upload);
  const missingFields = extractedPreview?.missingFields || [];

  return (
    <form onSubmit={submit} className="space-y-4 rounded-xl border border-white/15 bg-white/5 p-5 shadow-sm backdrop-blur">
      <div>
        <label className="mb-2 block text-sm font-medium text-slate-200">Paste context text</label>
        <textarea
          name="messageText"
          value={messageText}
          onChange={(event) => setMessageText(event.target.value)}
          placeholder="Paste email content here..."
          className="h-44 w-full rounded-md border border-white/20 bg-slate-900 p-3 text-sm text-white focus:border-blue-500 focus:outline-none"
        />
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium text-slate-200">Add To Workspace (optional)</label>
        <select
          name="workspaceEventId"
          value={workspaceEventId}
          onChange={(event) => setWorkspaceEventId(event.target.value)}
          className="w-full rounded-md border border-white/20 bg-slate-900 p-2 text-sm text-white focus:border-blue-500 focus:outline-none"
        >
          <option value="">Auto-match / create workspace</option>
          {workspaceOptions.map((workspace) => (
            <option key={workspace.eventId} value={workspace.eventId}>
              {workspace.label}
              {workspace.contact ? ` · ${workspace.contact}` : ""}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-slate-400">
          Select a workspace to force context routing even if name/contact details are missing in this new message.
        </p>
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium text-slate-200">Upload screenshot/document (txt, jpg, png, pdf, docx)</label>
        <input
          name="upload"
          type="file"
          onChange={(event) => setUpload(event.target.files?.[0] || null)}
          className="block w-full text-sm text-slate-300"
          accept=".txt,.jpg,.jpeg,.png,.pdf,.docx"
        />
      </div>

      <div className="rounded-lg border border-white/10 bg-black/20 p-3">
        <p className="text-xs font-semibold text-white">Fallback Contact (optional)</p>
        <p className="mt-1 text-xs text-slate-300">
          For text/iMessage screenshots with no visible contact details, add at least one contact type or select a workspace above.
        </p>
        <div className="mt-3 grid gap-2 md:grid-cols-3">
          <label className="text-xs text-slate-300">
            Email
            <input
              value={manualEmail}
              onChange={(event) => setManualEmail(event.target.value)}
              placeholder="name@example.com"
              className="mt-1 w-full rounded border border-white/20 bg-slate-900 px-2 py-1 text-sm text-white"
            />
          </label>
          <label className="text-xs text-slate-300">
            Phone Number
            <input
              value={manualPhone}
              onChange={(event) => setManualPhone(event.target.value)}
              placeholder="+1 555 123 4567"
              className="mt-1 w-full rounded border border-white/20 bg-slate-900 px-2 py-1 text-sm text-white"
            />
          </label>
          <label className="text-xs text-slate-300">
            Instagram Handle
            <input
              value={manualInstagramHandle}
              onChange={(event) => setManualInstagramHandle(event.target.value)}
              placeholder="@handle"
              className="mt-1 w-full rounded border border-white/20 bg-slate-900 px-2 py-1 text-sm text-white"
            />
          </label>
        </div>
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={loading}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? "Processing..." : "Process Context"}
        </button>
      </div>

      <div className="rounded-lg border border-white/10 bg-black/20 p-4">
        <h3 className="text-sm font-semibold text-white">Validation Layer</h3>
        <p className="mt-1 text-xs text-slate-300">This is the context payload that will be processed.</p>

        {!hasInput ? (
          <p className="mt-3 text-sm text-slate-400">Waiting for context text or document upload.</p>
        ) : (
          <div className="mt-3 space-y-3">
            <div>
              <p className="text-xs font-medium text-slate-200">Context text preview</p>
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded border border-white/20 bg-slate-900 p-2 text-xs text-slate-100">
                {messageText.trim() || "[No text pasted. Upload-only mode.]"}
              </pre>
            </div>

            <div className="grid gap-2 text-xs text-slate-200 md:grid-cols-2">
              <div><span className="font-medium">Client:</span> {extractedPreview?.clientName || "-"}</div>
              <div><span className="font-medium">Email:</span> {manualEmail.trim() || extractedPreview?.email || "-"}</div>
              <div><span className="font-medium">Phone:</span> {manualPhone.trim() || extractedPreview?.phone || "-"}</div>
              <div><span className="font-medium">Instagram:</span> {manualInstagramHandle.trim() || extractedPreview?.instagramHandle || "-"}</div>
              <div><span className="font-medium">Event date:</span> {formatDateLong({ timestamp: extractedPreview?.eventDateTimestamp, isoDate: extractedPreview?.eventDate })}</div>
              <div><span className="font-medium">Location:</span> {extractedPreview?.location || "-"}</div>
              <div><span className="font-medium">Event type:</span> {extractedPreview?.eventType || "-"}</div>
              <div><span className="font-medium">Services:</span> {extractedPreview?.servicesRequested?.join(", ") || "-"}</div>
            </div>

            {upload ? (
              <p className="text-xs text-slate-200"><span className="font-medium">Attached file:</span> {upload.name}</p>
            ) : null}

            <div className="flex flex-wrap gap-2">
              {missingFields.length ? (
                missingFields.map((field) => (
                  <span key={field} className="rounded-full border border-amber-200 bg-amber-100 px-2 py-0.5 text-[11px] text-amber-800">
                    missing: {field}
                  </span>
                ))
              ) : (
                <span className="rounded-full border border-emerald-200 bg-emerald-100 px-2 py-0.5 text-[11px] text-emerald-800">
                  context payload validated
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {showProcessing ? (
        <div className="rounded-lg border border-blue-400/30 bg-blue-500/10 p-4">
          <h3 className="text-sm font-semibold text-blue-100">Processing Status</h3>
          <p className="mt-1 text-xs text-blue-200">{processingNote || "Ready"}</p>

          <div className="mt-3 space-y-1">
            {STEP_ORDER.map((step) => {
              const status = steps[step.key];
              const tone =
                status === "done"
                  ? "text-emerald-700"
                  : status === "active"
                    ? "text-blue-700"
                    : status === "error"
                      ? "text-red-700"
                      : "text-gray-500";
              const marker = status === "done" ? "✓" : status === "active" ? "…" : status === "error" ? "✕" : "○";

              return (
                <p key={step.key} className={`text-xs ${tone}`}>
                  {marker} {step.label}
                </p>
              );
            })}
          </div>
        </div>
      ) : null}
    </form>
  );
}
