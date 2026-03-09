import fs from "fs/promises";
import path from "path";
import {
  AdminStore,
  BookingStage,
  Client,
  Communication,
  Contract,
  ContractDynamicFields,
  Event,
  EventStatus,
  ExtractedInquiry,
  Invoice,
  Inquiry,
  WorkspaceProfile,
  WorkspaceListItem,
  WorkspaceSnapshot,
} from "../types/models";
import { createId } from "../utils/id";
import { nowIso } from "../utils/time";
import { formatDateLong, normalizeTimestamp, parseDateToTimestamp, timestampToIsoDate } from "../utils/date";
import { readStore, writeStore } from "../persistence/store";
import { extractInquiryFromText } from "../inquiries/extract";
import { coerceExtractedLocationToCity } from "../inquiries/location";
import { matchExistingClientAndEvent } from "../inquiries/matching";
import { detectStage } from "../inquiries/stage";
import { renderContract, buildAmendmentSuggestion } from "../contracts/generate";
import { CONTRACT_LEGAL_BODY } from "../contracts/template";
import { invoiceFromContract, suggestInvoiceUpdates } from "../invoices/calc";
import { updateClientMarkdown } from "../clients/markdown";
import { saveGeneratedContract, saveUploadedFile } from "../persistence/files";
import { getClientsDir, getContractsDir, getUploadsDir } from "../persistence/paths";
import { runOcrAdapter } from "../inquiries/ocr-adapter";
import { buildInquiryProcessingPayload } from "../inquiries/payload";
import {
  AdminOwnerIdentity,
  codexDebugSummary,
  codexSignalLabel,
  extractInquiryWithCodex,
  extractWorkspaceProfileWithCodex,
  generateEmailDraftWithCodex,
  parseConversationContextWithCodex,
  semanticMatchWithCodex,
  shouldUseCodexForAdmin,
  summarizeInquiryWithCodex,
  suggestAmendmentWithCodex,
} from "../ai/codex-sdk";

// Legacy orchestration core:
// New imports should use domain entrypoints in `lib/admin/orchestration/*-service.ts`.
// This file remains the implementation source while logic is progressively split by domain.

const DEFAULT_BASE_RATE_PER_HOUR = 600;
const PAYMENT_MATCH_TOLERANCE = 1;
const CONTRACT_CHANGE_TOLERANCE = 1;
const DRAFT_FOLLOW_UP_WAIT_MS = 2 * 24 * 60 * 60 * 1000;
const DRAFT_FOLLOW_UP_WAIT_NOTICE =
  "No need to follow up yet, give the client some time. If there's no new context after 2 days, we can follow up.";
const DRAFT_CANCELLED_NOTICE = "Good effort, add context if they change their minds!";
const DEFAULT_OWNER_NAME = "Anupya Nalamalapu";
const DEFAULT_OWNER_EMAIL = "djanupya@gmail.com";
const DEFAULT_OWNER_PHONE = "+1 408 887 2397";
const DEFAULT_OWNER_INSTAGRAM = "@djanupya";

export type ChecklistProofKind = "signed_contract" | "deposit_proof" | "invoice_proof";

export interface ChecklistProofUploadResult {
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

function baseRatePerHour(store: AdminStore): number {
  const value = store.adminProfile?.baseHourlyRate;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_BASE_RATE_PER_HOUR;
}

function adminOwnerIdentity(store: AdminStore): AdminOwnerIdentity {
  return {
    name: (store.adminProfile?.ownerName || DEFAULT_OWNER_NAME).trim(),
    email: (store.adminProfile?.ownerEmail || DEFAULT_OWNER_EMAIL).trim().toLowerCase(),
    phone: (store.adminProfile?.ownerPhone || DEFAULT_OWNER_PHONE).trim(),
    instagramHandle: (store.adminProfile?.ownerInstagramHandle || DEFAULT_OWNER_INSTAGRAM).trim(),
  };
}

function parseClockToken(value: string): number | null {
  const token = value.trim().toLowerCase();
  const match = token.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || "0");
  const meridiem = match[3] as "am" | "pm" | undefined;

  if (minute < 0 || minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (hour === 12) {
      hour = 0;
    }
    if (meridiem === "pm") {
      hour += 12;
    }
  } else {
    if (hour < 0 || hour > 23) return null;
  }

  return hour * 60 + minute;
}

function parseClockTokenFlexible(value: string, fallbackMeridiem?: "am" | "pm"): number | null {
  const token = value.trim().toLowerCase();
  const match = token.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) return null;
  const explicitMeridiem = match[3] as "am" | "pm" | undefined;
  if (explicitMeridiem) {
    return parseClockToken(`${match[1]}:${match[2] || "00"} ${explicitMeridiem}`);
  }

  const hour = Number(match[1]);
  // Support 24-hour inputs like 19:00-00:00 for overnight events.
  if (hour === 0 || hour > 12) {
    return parseClockToken(`${match[1]}:${match[2] || "00"}`);
  }

  if (!fallbackMeridiem) {
    // If meridiem is omitted for both tokens (e.g. "6:30 - 11:30"),
    // keep a neutral 12-hour interpretation so duration stays computable.
    const minute = Number(match[2] || "00");
    return (hour % 12) * 60 + minute;
  }
  return parseClockToken(`${match[1]}:${match[2] || "00"} ${fallbackMeridiem}`);
}

function parseTimeRangeMinutes(value?: string): { startMinutes: number; endMinutes: number } | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  const match = normalized.match(
    /(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:-|–|—|to)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i
  );
  if (!match) return null;

  const startToken = match[1].trim();
  const endToken = match[2].trim();
  const startMeridiem = startToken.toLowerCase().includes("pm")
    ? "pm"
    : startToken.toLowerCase().includes("am")
      ? "am"
      : undefined;
  const endMeridiem = endToken.toLowerCase().includes("pm")
    ? "pm"
    : endToken.toLowerCase().includes("am")
      ? "am"
      : undefined;

  const startMinutes = parseClockTokenFlexible(startToken, startMeridiem || endMeridiem);
  const endMinutes = parseClockTokenFlexible(endToken, endMeridiem || startMeridiem);
  if (startMinutes === null || endMinutes === null) {
    return null;
  }

  return { startMinutes, endMinutes };
}

function timestampFromLocalMinutes(dateTs: number, totalMinutes: number, dayOffset: number = 0): number {
  const date = new Date(dateTs);
  date.setHours(0, 0, 0, 0);
  if (dayOffset) {
    date.setDate(date.getDate() + dayOffset);
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = ((totalMinutes % 60) + 60) % 60;
  date.setHours(hours, minutes, 0, 0);
  return date.getTime();
}

function windowFromDateAndRange(dateTs: number, range: { startMinutes: number; endMinutes: number }): {
  start: number;
  end: number;
} {
  const start = timestampFromLocalMinutes(dateTs, range.startMinutes, 0);
  const endDayOffset = range.endMinutes <= range.startMinutes ? 1 : 0;
  const end = timestampFromLocalMinutes(dateTs, range.endMinutes, endDayOffset);
  return { start, end };
}

function estimateHoursFromDuration(duration?: string): number | undefined {
  if (!duration) return undefined;
  const parsed = parseTimeRangeMinutes(duration);
  if (!parsed) return undefined;
  const start = parsed.startMinutes;
  const end = parsed.endMinutes;

  let diffMinutes = end - start;
  if (diffMinutes <= 0) {
    diffMinutes += 24 * 60;
  }

  const hours = diffMinutes / 60;
  if (!Number.isFinite(hours) || hours <= 0) return undefined;
  return Math.round(hours * 100) / 100;
}

function deriveAmountFromDuration(duration: string | undefined, baseRate: number): number | undefined {
  const hours = estimateHoursFromDuration(duration);
  if (!hours) return undefined;
  // Pricing policy: add one buffer hour per event before applying hourly rate.
  return Math.round((hours + 1) * baseRate);
}

function draftIndicatesUnavailable(value?: string): boolean {
  if (!value) return false;
  const lowered = value.toLowerCase();
  const patterns = [
    /\bunavailable\b/,
    /\bnot available\b/,
    /\bcan(?:not|'t)\s+make\b/,
    /\bwon'?t be able\b/,
    /\bnot able to\b/,
    /\bfully booked\b/,
  ];
  return patterns.some((pattern) => pattern.test(lowered));
}

function clientContextIndicatesCancellation(value?: string): boolean {
  if (!value) return false;
  const lowered = value.toLowerCase();
  const patterns = [
    /\bnot moving forward\b/,
    /\bno longer moving forward\b/,
    /\bwon'?t be moving forward\b/,
    /\bgoing with (another|someone else|a different)\b/,
    /\bgo(?:ing)? with (another|someone|someone else|somebody|a different)\b/,
    /\bchose (another|someone else|a different)\b/,
    /\bdecided to go with (another|someone|someone else|somebody|a different)\b/,
    /\bdecided to go with someone here\b/,
    /\bbring the cost down\b/,
    /\bdecided (not to|to not)\s+(book|sign|move forward)\b/,
    /\bwe are cancelling\b/,
    /\bwe're cancelling\b/,
    /\bcancel(?:ling|led)?\s+(this\s+)?(booking|event|contract)\b/,
    /\bwon'?t be needing\b/,
    /\bno longer interested\b/,
  ];
  return patterns.some((pattern) => pattern.test(lowered));
}

function contextIndicatesCancellation(value?: string): boolean {
  return draftIndicatesUnavailable(value) || clientContextIndicatesCancellation(value);
}

function signedContractState(event: Event, contract?: Contract): boolean {
  return Boolean(event.signedContract);
}

function depositSentState(event: Event, invoice?: Invoice): boolean {
  return Boolean(
    event.initialDepositReceived ||
      event.depositStatus === "received" ||
      invoice?.status === "paid_partial" ||
      invoice?.status === "paid"
  );
}

function isWorkspaceComplete(args: {
  event: Event;
  contract?: Contract;
  invoice?: Invoice;
  nowTs?: number;
}): boolean {
  const nowTs = args.nowTs || Date.now();
  const signed = signedContractState(args.event, args.contract);
  const depositSent = depositSentState(args.event, args.invoice);
  const fullInvoicePaid = args.invoice?.status === "paid";
  const endPassed = typeof args.event.workspaceEndTimestamp === "number" && args.event.workspaceEndTimestamp <= nowTs;
  return signed && depositSent && fullInvoicePaid && endPassed;
}

function applyCancellationSignal(event: Event, contextText?: string): void {
  if (!contextIndicatesCancellation(contextText)) return;
  event.status = "cancelled";
  event.signedContract = false;
  event.initialDepositReceived = false;
  event.depositStatus = "none";
}

function recomputeWorkspaceDateRange(event: Event, contract?: Contract, options?: { force?: boolean }): void {
  const force = Boolean(options?.force);
  const boundsLocked = event.workspaceDateBoundsLocked === true;
  if (
    !force &&
    boundsLocked &&
    typeof event.workspaceStartTimestamp === "number" &&
    typeof event.workspaceEndTimestamp === "number"
  ) {
    return;
  }
  if (!contract?.dynamicFields?.eventDetails?.length) {
    return;
  }

  let minStart: number | undefined;
  let maxEnd: number | undefined;

  for (const row of contract.dynamicFields.eventDetails) {
    const dateTs = parseDateToTimestamp(row.date || event.eventDate);
    if (!dateTs) continue;
    const range = parseTimeRangeMinutes(row.time);
    if (!range) continue;

    const { start: startTs, end: endTs } = windowFromDateAndRange(dateTs, range);

    if (typeof minStart !== "number" || startTs < minStart) {
      minStart = startTs;
    }
    if (typeof maxEnd !== "number" || endTs > maxEnd) {
      maxEnd = endTs;
    }
  }

  if (typeof minStart === "number" && typeof maxEnd === "number") {
    event.workspaceStartTimestamp = minStart;
    event.workspaceEndTimestamp = maxEnd;
    event.eventDateTimestamp = minStart;
    event.eventDate = timestampToIsoDate(minStart) || event.eventDate;
    return;
  }

  const fallbackDayTs = dayStartTimestamp(
    parseDateToTimestamp(event.eventDate) || normalizeTimestamp(event.eventDateTimestamp)
  );
  if (typeof fallbackDayTs === "number") {
    if (typeof event.workspaceStartTimestamp !== "number") {
      event.workspaceStartTimestamp = fallbackDayTs;
    }
    if (
      typeof event.workspaceEndTimestamp !== "number" ||
      event.workspaceEndTimestamp < (event.workspaceStartTimestamp || fallbackDayTs)
    ) {
      event.workspaceEndTimestamp = fallbackDayTs + 24 * 60 * 60000 - 1;
    }
    event.eventDateTimestamp = fallbackDayTs;
    event.eventDate = timestampToIsoDate(fallbackDayTs) || event.eventDate;
  }
}

function explicitDateYearsFromRawText(rawText?: string): number[] {
  const text = (rawText || "").trim();
  if (!text) return [];
  const years = new Set<number>();
  const patterns = [
    /\b(?:january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\s+\d{1,2}(?:st|nd|rd|th)?(?:\s*(?:,|-)\s*|\s+)(20\d{2})\b/gi,
    /\b\d{1,2}[/-]\d{1,2}[/-](20\d{2}|\d{2})\b/g,
    /\b(20\d{2})-\d{2}-\d{2}\b/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const rawYear = Number(match[1]);
      if (!Number.isFinite(rawYear)) continue;
      const year = rawYear < 100 ? 2000 + rawYear : rawYear;
      if (year >= 2000 && year <= 2100) {
        years.add(year);
      }
    }
  }

  for (const match of text.matchAll(/\b(20\d{2})\b/g)) {
    const year = Number(match[1]);
    if (Number.isFinite(year) && year >= 2000 && year <= 2100) {
      years.add(year);
    }
  }

  return Array.from(years);
}

function extractedStartYear(extracted: ExtractedInquiry): number | undefined {
  const ts = parseDateToTimestamp(extracted.eventDate) || normalizeTimestamp(extracted.eventDateTimestamp);
  if (typeof ts !== "number") return undefined;
  const date = new Date(ts);
  const year = date.getFullYear();
  return Number.isFinite(year) ? year : undefined;
}

function shouldAllowLockedDateOverride(args: {
  event: Event;
  extracted: ExtractedInquiry;
  rawText?: string;
}): boolean {
  if (args.event.workspaceDateBoundsLocked !== true) return false;
  const lockedTs = normalizeTimestamp(args.event.workspaceStartTimestamp);
  if (typeof lockedTs !== "number") return false;
  const lockedYear = new Date(lockedTs).getFullYear();
  const incomingYear = extractedStartYear(args.extracted);
  if (!incomingYear || incomingYear === lockedYear) return false;

  const explicitYears = explicitDateYearsFromRawText(args.rawText);
  if (!explicitYears.length) return false;
  return explicitYears.includes(incomingYear);
}

function applyExtractedDateWindow(
  event: Event,
  extracted: ExtractedInquiry,
  options?: { rawText?: string }
): void {
  const boundsLocked = event.workspaceDateBoundsLocked === true;
  const allowLockedOverride = shouldAllowLockedDateOverride({
    event,
    extracted,
    rawText: options?.rawText,
  });
  const canWriteBounds = !boundsLocked || allowLockedOverride;

  const startTs = parseDateToTimestamp(extracted.eventDate) || normalizeTimestamp(extracted.eventDateTimestamp);
  const canWriteCanonicalDate = canWriteBounds || typeof normalizeTimestamp(event.workspaceStartTimestamp) !== "number";
  if (typeof startTs === "number" && canWriteCanonicalDate) {
    const startDay = new Date(startTs);
    startDay.setHours(0, 0, 0, 0);
    const startDayTs = startDay.getTime();
    event.eventDateTimestamp = startDayTs;
    event.eventDate = timestampToIsoDate(startDayTs) || event.eventDate;
  }

  const endTs = parseDateToTimestamp(extracted.eventEndDate) || normalizeTimestamp(extracted.eventEndDateTimestamp);
  const hasTimeline = Boolean(extracted.duration || (extracted.timelineSegments || []).length);
  const timelineDayTs = (extracted.timelineSegments || [])
    .map((segment) => dayStartTimestamp(parseDateToTimestamp(segment.date)))
    .filter((value): value is number => typeof value === "number");
  if (
    typeof startTs === "number" &&
    typeof endTs === "number" &&
    endTs >= startTs &&
    (!hasTimeline || canWriteBounds)
  ) {
    const startDay = new Date(startTs);
    startDay.setHours(0, 0, 0, 0);
    const endDay = new Date(endTs);
    endDay.setHours(23, 59, 59, 999);
    event.workspaceStartTimestamp = startDay.getTime();
    event.workspaceEndTimestamp = endDay.getTime();
    if (allowLockedOverride) {
      event.workspaceDateBoundsLocked = true;
    }
    return;
  }

  if (timelineDayTs.length && canWriteBounds) {
    const minDay = Math.min(...timelineDayTs);
    const maxDay = Math.max(...timelineDayTs);
    event.workspaceStartTimestamp = minDay;
    event.workspaceEndTimestamp = maxDay + 24 * 60 * 60000 - 1;
    if (allowLockedOverride) {
      event.workspaceDateBoundsLocked = true;
    }
    return;
  }

  if (typeof startTs === "number" && canWriteBounds) {
    const startDay = new Date(startTs);
    startDay.setHours(0, 0, 0, 0);
    event.workspaceStartTimestamp = startDay.getTime();
    if (typeof endTs === "number" && endTs >= startTs) {
      const endDay = new Date(endTs);
      endDay.setHours(23, 59, 59, 999);
      event.workspaceEndTimestamp = endDay.getTime();
    } else {
      event.workspaceEndTimestamp = startDay.getTime() + 24 * 60 * 60000 - 1;
    }
    if (allowLockedOverride) {
      event.workspaceDateBoundsLocked = true;
    }
  }

  if (boundsLocked && !allowLockedOverride) {
    syncEventDateFromWorkspaceBounds(event);
  }
}

function applyTemporalWorkspaceStatus(
  event: Event,
  args?: {
    contract?: Contract;
    invoice?: Invoice;
  },
  nowTs: number = Date.now()
): void {
  if (event.status === "cancelled") {
    return;
  }

  if (isWorkspaceComplete({ event, contract: args?.contract, invoice: args?.invoice, nowTs })) {
    event.status = "completed";
    return;
  }

  if (event.status === "completed") {
    const signed = signedContractState(event, args?.contract);
    const depositSent = depositSentState(event, args?.invoice);
    if (signed && depositSent) {
      event.status = "deposit_received";
    } else if (signed) {
      event.status = "contract_approved";
    } else {
      event.status = "inquiry_received";
    }
  }
}

function shiftIsoDate(isoDate: string | undefined, days: number): string {
  const timestamp = parseDateToTimestamp(isoDate);
  if (!timestamp) return "";
  const shifted = new Date(timestamp);
  shifted.setDate(shifted.getDate() + days);
  return timestampToIsoDate(shifted.getTime()) || "";
}

function shiftIsoDateMonths(isoDate: string | undefined, months: number): string {
  const timestamp = parseDateToTimestamp(isoDate);
  if (!timestamp) return "";

  const source = new Date(timestamp);
  const targetYear = source.getFullYear();
  const targetMonthIndex = source.getMonth() + months;
  const lastDayOfTargetMonth = new Date(targetYear, targetMonthIndex + 1, 0).getDate();
  const targetDay = Math.min(source.getDate(), lastDayOfTargetMonth);
  const shifted = new Date(targetYear, targetMonthIndex, targetDay);
  return timestampToIsoDate(shifted.getTime()) || "";
}

function latestEventDateForContract(eventDetails: ContractDynamicFields["eventDetails"], fallbackDate?: string): string {
  let latestTimestamp: number | undefined;
  for (const row of eventDetails) {
    const ts = parseDateToTimestamp(row.date);
    if (!ts) continue;
    if (typeof latestTimestamp !== "number" || ts > latestTimestamp) {
      latestTimestamp = ts;
    }
  }

  if (typeof latestTimestamp === "number") {
    return timestampToIsoDate(latestTimestamp) || "";
  }

  const fallbackTimestamp = parseDateToTimestamp(fallbackDate);
  if (fallbackTimestamp) {
    return timestampToIsoDate(fallbackTimestamp) || (fallbackDate || "");
  }
  return fallbackDate || "";
}

function applyContractDatePolicy(fields: ContractDynamicFields): ContractDynamicFields {
  const requestedDueDate = (fields.dueDate || "").trim();
  const derivedDueDate = latestEventDateForContract(fields.eventDetails || [], requestedDueDate);
  const dueDate = requestedDueDate || derivedDueDate;
  const cancellationDate = shiftIsoDateMonths(dueDate, -6);

  return {
    ...fields,
    dueDate,
    cancellationDate,
  };
}

function workspaceDateBounds(event: Event): { startDayTs: number; endDayTs: number } | undefined {
  const startCandidate =
    normalizeTimestamp(event.workspaceStartTimestamp) ||
    dayStartTimestamp(parseDateToTimestamp(event.eventDate) || normalizeTimestamp(event.eventDateTimestamp));
  if (typeof startCandidate !== "number") return undefined;

  const endCandidate = normalizeTimestamp(event.workspaceEndTimestamp) || startCandidate;
  const startDayTs = dayStartTimestamp(startCandidate) || startCandidate;
  const endDayTs = dayStartTimestamp(endCandidate) || endCandidate;
  if (endDayTs < startDayTs) {
    return { startDayTs: endDayTs, endDayTs: startDayTs };
  }
  return { startDayTs, endDayTs };
}

function syncEventDateFromWorkspaceBounds(event: Event): void {
  const bounds = workspaceDateBounds(event);
  if (!bounds) return;
  event.eventDateTimestamp = bounds.startDayTs;
  event.eventDate = timestampToIsoDate(bounds.startDayTs) || event.eventDate;
}

function applyWorkspaceBoundsToContractFields(
  fields: ContractDynamicFields,
  event: Event
): ContractDynamicFields {
  const bounds = workspaceDateBounds(event);
  if (!bounds) {
    return applyContractDatePolicy(fields);
  }
  const boundsLocked = event.workspaceDateBoundsLocked === true;

  const startIso = timestampToIsoDate(bounds.startDayTs) || "";
  const totalDays = Math.max(1, Math.floor((bounds.endDayTs - bounds.startDayTs) / (24 * 60 * 60000)) + 1);
  const originalRows = fields.eventDetails || [];
  const hasAnyOriginalDateInBounds = originalRows.some((row) => {
    const rowDay = dayStartTimestamp(parseDateToTimestamp(row.date));
    return (
      typeof rowDay === "number" &&
      rowDay >= bounds.startDayTs &&
      rowDay <= bounds.endDayTs
    );
  });

  const eventDetails = originalRows.map((row, index) => {
    let rowDay = dayStartTimestamp(parseDateToTimestamp(row.date));
    if (typeof rowDay !== "number") {
      if (!hasAnyOriginalDateInBounds && totalDays > 1) {
        rowDay = bounds.startDayTs + Math.min(index, totalDays - 1) * 24 * 60 * 60000;
      } else {
        rowDay = bounds.startDayTs;
      }
    }
    if (boundsLocked) {
      if (rowDay < bounds.startDayTs) rowDay = bounds.startDayTs;
      if (rowDay > bounds.endDayTs) rowDay = bounds.endDayTs;
    }

    return {
      ...row,
      date: timestampToIsoDate(rowDay) || row.date || startIso,
    };
  });

  return applyContractDatePolicy({
    ...fields,
    eventDetails,
  });
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sameTimeWindow(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return a.toLowerCase().replace(/\s+/g, "") === b.toLowerCase().replace(/\s+/g, "");
}

function hasManualAmountOverride(args: {
  rowAmount: number;
  rowTime?: string;
  baseRate: number;
}): boolean {
  const computed = deriveAmountFromDuration(args.rowTime, args.baseRate);
  if (typeof computed !== "number") return false;
  return Math.abs(args.rowAmount - computed) >= 1;
}

function applyDerivedAmountsFromTime(args: {
  rows: ContractDynamicFields["eventDetails"];
  previousRows?: ContractDynamicFields["eventDetails"];
  baseRate: number;
}): ContractDynamicFields["eventDetails"] {
  const previousById = new Map((args.previousRows || []).map((row) => [row.id, row]));

  return args.rows.map((row) => {
    const numericAmount = Number(row.amount || 0);
    const derived = deriveAmountFromDuration(row.time, args.baseRate);
    if (typeof derived !== "number") {
      return {
        ...row,
        amount: Number.isFinite(numericAmount) ? numericAmount : 0,
      };
    }

    const previous = row.id ? previousById.get(row.id) : undefined;
    const timeChanged = previous ? !sameTimeWindow(previous.time, row.time) : false;
    const hasExplicitAmount = Number.isFinite(numericAmount) && numericAmount > 0;
    const shouldRecalculate = timeChanged || !hasExplicitAmount;

    return {
      ...row,
      amount: shouldRecalculate ? derived : numericAmount,
      manualOverridePrice:
        typeof row.manualOverridePrice === "number" && Number.isFinite(row.manualOverridePrice)
          ? row.manualOverridePrice
          : undefined,
    };
  });
}

function dynamicRowsFromExtraction(args: {
  extracted: ExtractedInquiry;
  currentFields?: ContractDynamicFields;
  baseRate: number;
}): ContractDynamicFields["eventDetails"] {
  const base = args.currentFields?.eventDetails || [];
  const first = base[0];
  const defaultDate = args.extracted.eventDate || first?.date || "";
  const defaultLocation = args.extracted.location || first?.location || "";
  const timeline = args.extracted.timelineSegments || [];

  if (timeline.length) {
    const usedIds = new Set<string>();
    return timeline.map((segment, index) => {
      const byTitle = base.find(
        (row) => normalizeKey(row.title) === normalizeKey(segment.title) && !usedIds.has(row.id)
      );
      const byTime = base.find((row) => sameTimeWindow(row.time, segment.time) && !usedIds.has(row.id));
      const byIndex = base[index] && !usedIds.has(base[index].id) ? base[index] : undefined;
      const matched = byTitle || byTime || byIndex;

      const computedAmount = deriveAmountFromDuration(segment.time, args.baseRate) ?? 0;
      const preserveManualAmount =
        !!matched &&
        sameTimeWindow(matched.time, segment.time) &&
        hasManualAmountOverride({
          rowAmount: Number(matched.amount || 0),
          rowTime: matched.time,
          baseRate: args.baseRate,
        });
      const matchedId = matched?.id;
      let rowId = matchedId && !usedIds.has(matchedId) ? matchedId : createId("detail");
      while (usedIds.has(rowId)) {
        rowId = createId("detail");
      }
      usedIds.add(rowId);

      return {
        id: rowId,
        title: segment.title || matched?.title || args.extracted.eventLabel || args.extracted.eventType || "Event",
        date: segment.date || defaultDate || matched?.date || "",
        time: segment.time || matched?.time || "",
        location: args.extracted.location || matched?.location || defaultLocation || "",
        notes: segment.notes || matched?.notes || "",
        amount: preserveManualAmount ? Number(matched?.amount || 0) : computedAmount || Number(matched?.amount || 0),
        manualOverridePrice: matched?.manualOverridePrice,
      };
    });
  }

  const row = first || {
    id: createId("detail"),
    title: "Event",
    date: "",
    time: "",
    location: "",
    notes: "",
    amount: 0,
  };
  const nextTime = args.extracted.duration || "";
  const computedAmount = deriveAmountFromDuration(nextTime, args.baseRate) ?? 0;
  const preserveManualAmount =
    sameTimeWindow(row.time, nextTime) &&
    hasManualAmountOverride({
      rowAmount: Number(row.amount || 0),
      rowTime: row.time,
      baseRate: args.baseRate,
    });

  return [
    {
      ...row,
      title: args.extracted.eventLabel || args.extracted.eventType || row.title || "Event",
      date: args.extracted.eventDate || row.date || "",
      time: nextTime,
      location: args.extracted.location || row.location || defaultLocation || "",
      notes: row.notes || "",
      amount: preserveManualAmount ? Number(row.amount || 0) : computedAmount || Number(row.amount || 0),
      manualOverridePrice: row.manualOverridePrice,
    },
  ];
}

function defaultDynamicFields(extracted: ExtractedInquiry, baseRate: number): ContractDynamicFields {
  const date = extracted.eventDate || "";
  const location = extracted.location || "";
  const extractedRows = dynamicRowsFromExtraction({
    extracted,
    baseRate,
  });
  const eventDetails = extractedRows.length
    ? extractedRows
    : [
        {
          id: createId("detail"),
          title: extracted.eventLabel || extracted.eventType || "Event",
          date,
          time: extracted.duration || "",
          location,
          notes: "",
          amount: deriveAmountFromDuration(extracted.duration, baseRate) || 0,
        },
      ];
  const dueDate = latestEventDateForContract(eventDetails, date);
  const cancellationDate = shiftIsoDateMonths(dueDate, -6);

  return {
    eventDetails,
    travelAmount: 0,
    totalAmount: 0,
    depositAmount: 0,
    remainingAmount: 0,
    dueDate,
    cancellationDate,
  };
}

function refreshDynamicFieldsFromExtraction(
  currentFields: ContractDynamicFields | undefined,
  extracted: ExtractedInquiry,
  baseRate: number
): ContractDynamicFields {
  const base = currentFields || defaultDynamicFields(extracted, baseRate);
  const eventDetails = dynamicRowsFromExtraction({
    extracted,
    currentFields: base,
    baseRate,
  });
  const dueDate = latestEventDateForContract(eventDetails, extracted.eventDate || base.dueDate);
  const cancellationDate = shiftIsoDateMonths(dueDate, -6);

  return {
    ...base,
    eventDetails,
    dueDate,
    cancellationDate,
  };
}

function missingFieldQuestions(missingFields: string[], baseRate: number): string[] {
  const set = new Set(missingFields);
  const questions: string[] = [];

  if (set.has("event_time")) {
    questions.push(`What are the start and end times for each event segment? I price core performance time at $${baseRate}/hour.`);
  }
  if (set.has("event_date")) {
    questions.push("Can you confirm the event date?");
  }
  if (set.has("location")) {
    questions.push("Can you confirm the venue/location?");
  }
  if (set.has("services_requested")) {
    questions.push("Which services do you want included (DJ, MC, lighting, dhol, baraat setup, etc.)?");
  }
  if (set.has("email")) {
    questions.push("What is the best email for contract and invoice delivery?");
  }

  return questions;
}

type ContextActor = "client" | "me" | "unknown";
type ContextChannel = "email" | "text" | "instagram" | "call" | "unknown";

interface ContextEntry {
  actor: ContextActor;
  channel: ContextChannel;
  dateLabel?: string;
  content: string;
}

function inferContextChannel(args: {
  rawText: string;
  hasUpload: boolean;
}): ContextChannel {
  const text = (args.rawText || "").toLowerCase();
  if (/\binstagram\b|\bdm\b|\big\b/.test(text)) return "instagram";
  if (/\bto:\s*[a-z]/i.test(args.rawText) || /\bdelivered\b|\bimessage\b/.test(text)) return "text";
  if (/\bsubject:|\bto me\b|@[a-z0-9.-]+\.[a-z]{2,}/i.test(args.rawText)) return "email";
  if (/\bcall\b|\bphone\b/.test(text)) return "call";
  if (args.hasUpload) return "unknown";
  return "email";
}

function parseTimestampLine(value: string): string | undefined {
  const line = value.trim();
  if (!line) return undefined;
  if (/^(today|yesterday)\s+\d{1,2}:\d{2}\s*(am|pm)$/i.test(line)) return line;
  if (
    /^(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+\d{1,2}(?:,\s*\d{2,4})?\s+\d{1,2}:\d{2}\s*(am|pm)$/i.test(
      line
    )
  ) {
    return line;
  }
  return undefined;
}

function parseConversationHeuristic(rawText: string, defaultChannel: ContextChannel): ContextEntry[] {
  const lines = rawText.replace(/\r/g, "").split("\n");
  const entries: ContextEntry[] = [];
  let currentDate: string | undefined;
  let buffer: string[] = [];
  const hasToHeader = /^\s*to:\s*[a-z]/im.test(rawText);
  const hasDeliveredMarker = /(?:^|\n)\s*delivered\s*$/im.test(rawText);
  const likelyTextScreenshot = defaultChannel === "text" || hasToHeader || hasDeliveredMarker;

  function isUiNoiseLine(value: string): boolean {
    const line = value.trim();
    if (!line) return false;
    if (/^to:\s*/i.test(line)) return true;
    if (/^(imessage|message|messages)$/i.test(line)) return true;
    if (/^share your name and photo\??$/i.test(line)) return true;
    if (/^delivered$/i.test(line)) return true;
    return false;
  }

  function flushBuffer() {
    const filtered = buffer.filter((line) => !isUiNoiseLine(line));
    const content = filtered.join("\n").trim();
    buffer = [];
    if (!content) return;
    entries.push({
      actor: "unknown",
      channel: defaultChannel,
      dateLabel: currentDate,
      content,
    });
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const timestamp = parseTimestampLine(line);
    if (timestamp) {
      flushBuffer();
      currentDate = timestamp;
      continue;
    }
    if (!line) {
      flushBuffer();
      continue;
    }
    buffer.push(line);
  }
  flushBuffer();

  if (likelyTextScreenshot && entries.length >= 2) {
    const outboundTailPattern =
      /^(?:\*|no worries|all good|got it|sounds good|perfect|awesome|of course|happy to|i can|i'll|i will|totally)\b/i;
    const last = entries[entries.length - 1];
    const rows = last.content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (hasDeliveredMarker && rows.length >= 3) {
      let splitIndex = rows.length;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (outboundTailPattern.test(rows[i])) {
          splitIndex = i;
        } else if (splitIndex < rows.length) {
          break;
        }
      }
      if (splitIndex > 0 && splitIndex < rows.length) {
        const clientPart = rows.slice(0, splitIndex).join("\n").trim();
        const myPart = rows.slice(splitIndex).join("\n").trim();
        if (clientPart && myPart) {
          entries[entries.length - 1] = {
            ...last,
            actor: "client",
            content: clientPart,
          };
          entries.push({
            actor: "me",
            channel: defaultChannel,
            dateLabel: last.dateLabel,
            content: myPart,
          });
        }
      }
    }
  }

  if (likelyTextScreenshot && entries.length) {
    if (hasToHeader) {
      entries[0].actor = "me";
      if (entries.length === 2) {
        entries[1].actor = hasDeliveredMarker ? "client" : "client";
      } else if (entries.length >= 3) {
        entries[entries.length - 1].actor = hasDeliveredMarker ? "me" : "client";
        let nextActor: "client" | "me" = "client";
        for (let i = 1; i < entries.length - 1; i += 1) {
          entries[i].actor = nextActor;
          nextActor = nextActor === "client" ? "me" : "client";
        }
      }
    } else {
      entries.forEach((entry) => {
        if (entry.actor === "unknown") {
          entry.actor = "client";
        }
      });
    }
  }

  if (!entries.length) {
    return [
      {
        actor: "client",
        channel: defaultChannel,
        dateLabel: undefined,
        content: rawText.trim(),
      },
    ];
  }

  return entries;
}

function formatContextEntry(entry: ContextEntry): string {
  return `[context]
actor: ${entry.actor}
channel: ${entry.channel}
date: ${entry.dateLabel || "unknown"}
content:
${entry.content.trim()}
[/context]`;
}

function appendRawInquiryFeed(existing: string | undefined, incoming: string): string {
  const next = (incoming || "").trim();
  if (!next) return (existing || "").trim();

  const previous = (existing || "").trim();
  if (!previous) return next;
  if (previous.includes(next)) return previous;

  return `${previous}\n\n----- New Context -----\n\n${next}`;
}

function appendWorkspaceContext(existing: string | undefined, contextBlock: string): string {
  const block = (contextBlock || "").trim();
  const previous = (existing || "").trim();
  if (!block) return previous;
  if (previous.includes(block)) return previous;
  if (!previous) return block;
  return `${previous}\n\n${block}`;
}

async function buildInboundContextBlock(args: {
  rawText: string;
  hasUpload: boolean;
  clientName?: string;
  ownerIdentity?: AdminOwnerIdentity;
}): Promise<string> {
  const text = (args.rawText || "").trim();
  if (!text) return "";

  const defaultChannel = inferContextChannel({ rawText: text, hasUpload: args.hasUpload });
  let entries: ContextEntry[] = args.hasUpload
    ? parseConversationHeuristic(text, defaultChannel)
    : [
        {
          actor: "client",
          channel: defaultChannel,
          dateLabel: undefined,
          content: text,
        },
      ];

  if (args.hasUpload) {
    const parsed = await parseConversationContextWithCodex({
      rawText: text,
      defaultChannel,
      knownClientName: args.clientName,
      ownerIdentity: args.ownerIdentity,
    });
    if (parsed.entries.length) {
      entries = parsed.entries.map((entry) => ({
        actor: entry.actor,
        channel: entry.channel,
        dateLabel: entry.dateLabel,
        content: entry.content,
      }));
    }
  }

  if (!entries.length) {
    entries = [
      {
        actor: "client",
        channel: defaultChannel,
        content: text,
      },
    ];
  }

  return entries.map((entry) => formatContextEntry(entry)).join("\n\n");
}

function latestContextFromRawFeed(rawFeed: string): string {
  const feed = (rawFeed || "").trim();
  if (!feed) return "";

  const markerMatches = [...feed.matchAll(/-----\s*(New Inquiry|New Context|Workspace Context:[^-]+)\s*-----/g)];
  if (!markerMatches.length) {
    return feed;
  }

  const lastMarker = markerMatches[markerMatches.length - 1];
  const markerStart = lastMarker.index || 0;
  const markerText = lastMarker[0];
  const afterMarker = feed.slice(markerStart + markerText.length).trim();

  if (afterMarker) {
    return afterMarker;
  }

  return feed.slice(markerStart).trim();
}

function parseContextBlock(block: string): { actor: string; content: string } {
  const actor = block.match(/(?:^|\n)\s*actor:\s*([^\n]+)/i)?.[1]?.trim().toLowerCase() || "unknown";
  const contentMatch = block.match(/(?:^|\n)\s*content:\s*\n?([\s\S]*)$/i);
  const content = (contentMatch?.[1] || "").trim();
  return { actor, content };
}

function latestInboundContextForDraft(rawFeed: string): string {
  const feed = (rawFeed || "").trim();
  if (!feed) return "";

  const blocks = [...feed.matchAll(/\[context\]\s*([\s\S]*?)\[\/context\]/gi)]
    .map((match) => parseContextBlock(match[1] || ""))
    .filter((item) => item.content);

  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const row = blocks[i];
    if (row.actor === "client" || row.actor === "unknown") {
      return row.content;
    }
  }

  return latestContextFromRawFeed(feed);
}

function lastRawFeedMarker(rawFeed: string): string | undefined {
  const feed = (rawFeed || "").trim();
  if (!feed) return undefined;
  const markerMatches = [...feed.matchAll(/-----\s*(New Inquiry|New Context|Workspace Context:[^-]+)\s*-----/g)];
  if (!markerMatches.length) return undefined;
  return (markerMatches[markerMatches.length - 1][1] || "").trim();
}

function shouldGenerateCheckInDraft(rawFeed: string): boolean {
  const marker = (lastRawFeedMarker(rawFeed) || "").toLowerCase();
  return marker.startsWith("workspace context: approved draft email");
}

function quoteInfoAlreadyShared(rawFeed: string): boolean {
  const feed = (rawFeed || "").trim();
  if (!feed) return false;

  const blocks = [...feed.matchAll(/----- Workspace Context: Approved Draft Email -----\s*([\s\S]*?)(?=\n\n-----\s*(?:New Inquiry|New Context|Workspace Context:)|$)/gi)];
  if (!blocks.length) return false;

  const quotePatterns = [
    /\$?\s*7,?000\s*-\s*\$?\s*8,?000/,
    /\bbase rate\b/,
    /\bfull indian wedding package\b/,
    /\bmore accurate quote\b/,
    /\bpricing\b/,
  ];

  return blocks.some((match) => {
    const content = (match[1] || "").toLowerCase();
    return quotePatterns.some((pattern) => pattern.test(content));
  });
}

function approvedDraftBlocks(rawFeed: string): string[] {
  const feed = (rawFeed || "").trim();
  if (!feed) return [];
  const blocks = [...feed.matchAll(/----- Workspace Context: Approved Draft Email -----\s*([\s\S]*?)(?=\n\n-----\s*(?:New Inquiry|New Context|Workspace Context:)|$)/gi)];
  return blocks.map((match) => (match[1] || "").trim()).filter(Boolean);
}

function latestApprovedDraftBlock(rawFeed: string): string {
  const blocks = approvedDraftBlocks(rawFeed);
  if (!blocks.length) return "";
  return blocks[blocks.length - 1];
}

type PricingDirective =
  | { kind: "set_total"; amount: number; sourceText: string }
  | { kind: "delta_amount"; amount: number; sourceText: string }
  | { kind: "delta_percent"; percent: number; sourceText: string };

interface EventPriceOverride {
  title: string;
  amount: number;
}

function parseAmountLiteral(value: string): number | null {
  const token = (value || "").trim().toLowerCase();
  if (!token) return null;
  const compact = token.replace(/\s+/g, "");
  if (!compact) return null;
  if (/^\d+(?:\.\d+)?k$/.test(compact)) {
    const numeric = Number(compact.slice(0, -1));
    if (!Number.isFinite(numeric)) return null;
    return Math.round(numeric * 1000);
  }
  const numeric = Number(compact.replace(/,/g, ""));
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric);
}

function hasRangeAfter(text: string, endIndex: number): boolean {
  const tail = (text || "").slice(endIndex, endIndex + 16);
  return /^\s*(?:-|–|—|to)\s*\$?\s*\d/.test(tail);
}

function parsePricingDirectiveFromText(text: string): PricingDirective | null {
  const source = (text || "").trim();
  if (!source) return null;

  const setTotalRegexes = [
    /(?:new|updated)\s+(?:quote|price|pricing|total)\s*(?:is|at|for|:)\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?|\d+(?:\.\d+)?k)\b/gi,
    /(?:total|quote|price|pricing|package)\s*(?:would be|will be|is|at|for|comes to)\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?|\d+(?:\.\d+)?k)\b/gi,
    /(?:i can|we can)\s*(?:do|offer|quote|price(?:\s*it)?|lock(?:\s*in)?)\s*(?:this)?\s*(?:at|for)?\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?|\d+(?:\.\d+)?k)\b/gi,
  ];
  let bestSet: { amount: number; index: number } | null = null;
  for (const regex of setTotalRegexes) {
    for (const match of source.matchAll(regex)) {
      const start = match.index || 0;
      const end = start + match[0].length;
      if (hasRangeAfter(source, end)) continue;
      const amount = parseAmountLiteral(match[1] || "");
      if (amount === null || amount < 250 || amount > 500_000) continue;
      if (!bestSet || start >= bestSet.index) {
        bestSet = { amount, index: start };
      }
    }
  }
  if (bestSet) {
    return { kind: "set_total", amount: bestSet.amount, sourceText: source };
  }

  const percentRules: Array<{ regex: RegExp; sign: -1 | 1 }> = [
    { regex: /(?:discount|off)\s*(?:of\s*)?([0-9]{1,2}(?:\.[0-9]+)?)\s*%/gi, sign: -1 },
    { regex: /([0-9]{1,2}(?:\.[0-9]+)?)\s*%\s*(?:discount|off)\b/gi, sign: -1 },
    { regex: /(?:reduce|lower|decrease)\s*(?:the\s+)?(?:price|total|quote)?\s*(?:by\s*)?([0-9]{1,2}(?:\.[0-9]+)?)\s*%/gi, sign: -1 },
    { regex: /(?:increase|raise|higher)\s*(?:the\s+)?(?:price|total|quote)?\s*(?:by\s*)?([0-9]{1,2}(?:\.[0-9]+)?)\s*%/gi, sign: 1 },
  ];
  let bestPercent: { percent: number; index: number } | null = null;
  for (const rule of percentRules) {
    for (const match of source.matchAll(rule.regex)) {
      const percent = Number(match[1]);
      if (!Number.isFinite(percent) || percent <= 0 || percent > 80) continue;
      const index = match.index || 0;
      const signedPercent = rule.sign * percent;
      if (!bestPercent || index >= bestPercent.index) {
        bestPercent = { percent: signedPercent, index };
      }
    }
  }
  if (bestPercent) {
    return {
      kind: "delta_percent",
      percent: bestPercent.percent,
      sourceText: source,
    };
  }

  const amountRules: Array<{ regex: RegExp; sign: -1 | 1 }> = [
    { regex: /(?:discount|off)\s*(?:of\s*)?\$?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?|\d+(?:\.\d+)?k)\b/gi, sign: -1 },
    { regex: /\$?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?|\d+(?:\.\d+)?k)\s*(?:discount|off)\b/gi, sign: -1 },
    { regex: /(?:reduce|lower|decrease)\s*(?:the\s+)?(?:price|total|quote)?\s*(?:by\s*)?\$?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?|\d+(?:\.\d+)?k)\b/gi, sign: -1 },
    { regex: /(?:increase|raise|higher|add)\s*(?:the\s+)?(?:price|total|quote)?\s*(?:by\s*)?\$?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?|\d+(?:\.\d+)?k)\b/gi, sign: 1 },
  ];
  let bestDelta: { amount: number; index: number } | null = null;
  for (const rule of amountRules) {
    for (const match of source.matchAll(rule.regex)) {
      const amount = parseAmountLiteral(match[1] || "");
      if (amount === null || amount <= 0 || amount > 100_000) continue;
      const index = match.index || 0;
      const signedAmount = rule.sign * amount;
      if (!bestDelta || index >= bestDelta.index) {
        bestDelta = { amount: signedAmount, index };
      }
    }
  }

  if (bestDelta) {
    return {
      kind: "delta_amount",
      amount: bestDelta.amount,
      sourceText: source,
    };
  }

  return null;
}

function normalizeEventTitleKey(value: string): string {
  return (value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function parseEventPriceOverridesFromText(text: string): EventPriceOverride[] {
  const source = (text || "").trim();
  if (!source) return [];

  const skipTitlePatterns: RegExp[] = [
    /\btotal\b/i,
    /\bquote\b/i,
    /\bbreakdown\b/i,
    /\bavailable\b/i,
    /\bthanks\b/i,
    /\blet me know\b/i,
    /\bhappy to\b/i,
    /\bbest\b/i,
    /\bcalculation\b/i,
    /\bevents?\b/i,
    /\b(i|we|you|can|will|would|could|am|are|is|bring|offer|do|did)\b/i,
  ];

  const overrides: EventPriceOverride[] = [];
  const lines = source.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const normalizedLine = line.replace(/^(?:[-*•]\s*)/, "").trim();
    const parsedWithSeparator =
      normalizedLine.match(
        /^(.{2,80}?)\s*(?::|[-–—])\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?|\d+(?:\.\d+)?k)\b(?:\s*\([^)]*\))?\s*$/i
      ) ||
      normalizedLine.match(
        /^(.{2,80}?)\s+\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?|\d+(?:\.\d+)?k)\b(?:\s*\([^)]*\))?\s*$/i
      );
    if (!parsedWithSeparator) continue;

    const amount = parseAmountLiteral(parsedWithSeparator[2] || "");
    if (amount === null || amount < 0 || amount > 500_000) continue;
    const hasExplicitDollar = /\$\s*[0-9]/.test(normalizedLine);
    if (amount < 100 && !hasExplicitDollar) continue;

    const title = (parsedWithSeparator[1] || "")
      .trim()
      .replace(/[-—–:]\s*$/g, "")
      .replace(/\((?:[^)]*\d{1,2}:\d{2}[^)]*)\)\s*$/i, "")
      .replace(/\(\s*$/g, "")
      .trim();
    if (!title) continue;
    const titleWordCount = title.split(/\s+/).filter(Boolean).length;
    if (titleWordCount > 4) continue;
    if (!/^[a-z0-9][a-z0-9 '&/+()\-]*$/i.test(title)) continue;
    if (skipTitlePatterns.some((pattern) => pattern.test(title))) continue;

    overrides.push({
      title,
      amount,
    });
  }

  const deduped = new Map<string, EventPriceOverride>();
  for (const item of overrides) {
    deduped.set(normalizeEventTitleKey(item.title), item);
  }
  return Array.from(deduped.values());
}

function applyEventPriceOverrides(fields: ContractDynamicFields, overrides: EventPriceOverride[]): ContractDynamicFields {
  if (!overrides.length) return fields;
  const originalRows = (fields.eventDetails || []).map((row) => ({ ...row }));
  const rows = originalRows.map((row) => ({ ...row }));
  const usedRowIndexes = new Set<number>();

  for (const override of overrides) {
    const overrideKey = normalizeEventTitleKey(override.title);
    if (!overrideKey) continue;

    let matchedIndex = rows.findIndex(
      (row, index) => !usedRowIndexes.has(index) && normalizeEventTitleKey(row.title) === overrideKey
    );
    if (matchedIndex < 0) {
      matchedIndex = rows.findIndex((row, index) => {
        if (usedRowIndexes.has(index)) return false;
        const rowKey = normalizeEventTitleKey(row.title);
        return rowKey.includes(overrideKey) || overrideKey.includes(rowKey);
      });
    }

    if (matchedIndex >= 0) {
      usedRowIndexes.add(matchedIndex);
      const predictedAmount = Number(rows[matchedIndex].amount || 0);
      const hasDifference = Math.abs(predictedAmount - override.amount) >= 1;
      rows[matchedIndex] = {
        ...rows[matchedIndex],
        title: override.title,
        manualOverridePrice: hasDifference ? override.amount : undefined,
      };
      continue;
    }

    const anchor = rows[0];
    rows.push({
      id: createId("detail"),
      title: override.title,
      date: anchor?.date || "",
      time: "",
      location: anchor?.location || "",
      notes: anchor?.notes || "",
      amount: override.amount,
    });
  }

  if (overrides.length >= 2) {
    const placeholderTitles = new Set([
      "event",
      "wedding",
      "core performance",
      "performance",
      "dj service",
      "service",
      "event details",
    ]);
    const cleanedRows = rows.filter((row, index) => {
      const key = normalizeEventTitleKey(row.title);
      if (!placeholderTitles.has(key)) return true;
      return usedRowIndexes.has(index);
    });
    return {
      ...fields,
      eventDetails: cleanedRows.length ? cleanedRows : rows,
    };
  }

  return {
    ...fields,
    eventDetails: rows,
  };
}

function contractTotalFromFields(fields: ContractDynamicFields): number {
  const eventTotal = (fields.eventDetails || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
  return Math.max(0, Math.round(eventTotal + Number(fields.travelAmount || 0)));
}

function applyTargetTotalToFields(fields: ContractDynamicFields, targetTotalAmount: number): ContractDynamicFields {
  const targetTotal = Math.max(0, Math.round(targetTotalAmount));
  const travelAmount = Number(fields.travelAmount || 0);
  const targetEventsTotal = Math.max(0, Math.round(targetTotal - travelAmount));
  const rows = (fields.eventDetails || []).map((row) => ({
    ...row,
    amount: Math.max(0, Number(row.amount || 0)),
  }));
  if (!rows.length) {
    return fields;
  }

  const currentEventsTotal = rows.reduce((sum, row) => sum + row.amount, 0);
  if (currentEventsTotal <= 0) {
    return {
      ...fields,
      eventDetails: rows.map((row, index) => ({
        ...row,
        amount: index === 0 ? targetEventsTotal : 0,
      })),
    };
  }

  const scaled = rows.map((row) => Math.max(0, Math.round((row.amount / currentEventsTotal) * targetEventsTotal)));
  const scaledSum = scaled.reduce((sum, amount) => sum + amount, 0);
  const delta = targetEventsTotal - scaledSum;
  scaled[scaled.length - 1] = Math.max(0, scaled[scaled.length - 1] + delta);

  return {
    ...fields,
    eventDetails: rows.map((row, index) => ({
      ...row,
      amount: scaled[index],
    })),
  };
}

function applyPricingDirective(fields: ContractDynamicFields, directive: PricingDirective | null): ContractDynamicFields {
  if (!directive) return fields;
  const currentTotal = contractTotalFromFields(fields);
  if (directive.kind === "set_total") {
    return applyTargetTotalToFields(fields, directive.amount);
  }
  if (directive.kind === "delta_amount") {
    return applyTargetTotalToFields(fields, currentTotal + directive.amount);
  }
  const adjusted = Math.round(currentTotal * (1 + directive.percent / 100));
  return applyTargetTotalToFields(fields, adjusted);
}

function applyPricingDirectiveFromRawContext(fields: ContractDynamicFields, rawFeed?: string): ContractDynamicFields {
  const approvedDraft = latestApprovedDraftBlock(rawFeed || "");
  if (!approvedDraft) return fields;
  const eventOverrides = parseEventPriceOverridesFromText(approvedDraft);
  if (eventOverrides.length) {
    return applyEventPriceOverrides(fields, eventOverrides);
  }
  const directive = parsePricingDirectiveFromText(approvedDraft);
  return applyPricingDirective(fields, directive);
}

function hasPriorConversationContext(args: {
  inquiryCount: number;
  rawFeed?: string;
}): boolean {
  if (args.inquiryCount > 1) return true;
  const rawFeed = (args.rawFeed || "").trim();
  if (!rawFeed) return false;
  return rawFeed.includes("----- New Inquiry -----") || rawFeed.includes("----- New Context -----");
}

function buildApprovedContextBlock(args: {
  artifactType: "draft_email" | "contract";
  content: string;
}): string {
  const normalized = (args.content || "").trim();
  if (!normalized) return "";
  const title = args.artifactType === "draft_email" ? "Approved Draft Email" : "Approved Contract";
  return `----- Workspace Context: ${title} -----\n${normalized}`;
}

function addApprovedTrainingExample(args: {
  store: AdminStore;
  clientId: string;
  event: Event;
  latestInquiry?: Inquiry;
  generatedOutput: string;
  finalOutput: string;
  artifactType: "draft_email" | "contract";
  now: string;
}) {
  const finalOutput = (args.finalOutput || "").trim();
  if (!finalOutput) return;

  const alreadyExists = args.store.trainingExamples.some((example) => {
    if (example.eventId !== args.event.id) return false;
    if (example.decision !== "approved") return false;
    if (example.artifactType !== args.artifactType) return false;
    return (example.finalOutput || "").trim() === finalOutput;
  });
  if (alreadyExists) return;

  const originalInquiry = (args.latestInquiry?.extractedText || args.event.latestOcrText || "").trim();
  if (!originalInquiry) return;

  const generatedOutput = (args.generatedOutput || "").trim() || finalOutput;
  const changeSummary =
    args.artifactType === "draft_email"
      ? "Auto-captured from approved draft email."
      : "Auto-captured from approved contract.";

  args.store.trainingExamples.push({
    id: createId("train"),
    clientId: args.clientId,
    eventId: args.event.id,
    stage: args.event.stage,
    originalInquiry,
    generatedOutput,
    finalOutput,
    decision: "approved",
    changeSummary,
    artifactType: args.artifactType,
    autoCaptured: true,
    createdAt: args.now,
  });
}

function addContractMemorySnapshot(args: {
  store: AdminStore;
  clientId: string;
  event: Event;
  contract: Contract;
  now: string;
  changeSummary?: string;
}) {
  const rawContextSnapshot = (args.event.latestOcrText || "").trim();
  const rendered = (args.contract.renderedText || "").trim();
  if (!rendered) return;

  args.store.trainingExamples.push({
    id: createId("train"),
    clientId: args.clientId,
    eventId: args.event.id,
    stage: args.event.stage,
    originalInquiry: rawContextSnapshot || rendered,
    generatedOutput: rendered,
    finalOutput: rendered,
    decision: "approved",
    changeSummary:
      args.changeSummary ||
      `Contract v${args.contract.version} approved and saved from current workspace context.`,
    artifactType: "contract",
    autoCaptured: true,
    rawContextSnapshot,
    contractDynamicFieldsSnapshot: structuredClone(args.contract.dynamicFields),
    contractVersionSnapshot: args.contract.version,
    createdAt: args.now,
  });
}

function summarizeServices(services: string[]): string {
  if (!services.length) return "no specific services captured yet";
  return services.join(", ");
}

function buildFallbackInquirySummary(args: {
  extracted: ExtractedInquiry;
  stage: BookingStage;
  rawText: string;
}): string {
  const eventType = args.extracted.eventType || "event";
  const date = args.extracted.eventDate || "date pending";
  const venue = args.extracted.location || "venue pending";
  const services = summarizeServices(args.extracted.servicesRequested);
  const missing = args.extracted.missingFields.length ? ` Missing details: ${args.extracted.missingFields.join(", ")}.` : "";
  return `Client context is in ${args.stage} stage for a ${eventType}. Current details include date ${date}, venue ${venue}, and services ${services}.${missing}`;
}

function isSafeLocationValue(value?: string): boolean {
  if (!value) return false;
  const lowered = value.toLowerCase();
  const blocked: RegExp[] = [
    /\bthanks\b/,
    /\badvance\b/,
    /\bpricing\b/,
    /\bincluded\b/,
    /\btimeline\b/,
    /\bcall\b/,
    /\bchat\b/,
    /that night/,
    /\bto me\b/,
  ];
  return !blocked.some((pattern) => pattern.test(lowered));
}

function isKnownClientEmail(value?: string): boolean {
  const email = (value || "").trim().toLowerCase();
  if (!email) return false;
  if (email.endsWith("@example.local")) return false;
  return true;
}

function normalizeInstagramHandle(value?: string): string | undefined {
  const cleaned = (value || "").trim().toLowerCase().replace(/^@+/, "");
  if (!cleaned) return undefined;
  if (!/^[a-z0-9._]{2,30}$/.test(cleaned)) return undefined;
  if (/\.(com|net|org|edu|gov|io|co)$/i.test(cleaned)) return undefined;
  return `@${cleaned}`;
}

function normalizeProfileText(value?: string): string {
  return (value || "").replace(/\s+/g, " ").trim();
}

function normalizeProfileEmail(value?: string): string {
  return normalizeProfileText(value).toLowerCase();
}

function normalizeProfilePhone(value?: string): string {
  return normalizeProfileText(value);
}

function normalizePhoneForCompare(value?: string): string {
  const digits = (value || "").replace(/\D+/g, "");
  if (!digits) return "";
  // Normalize to comparable local format so +1XXXXXXXXXX and XXXXXXXXXX match.
  if (digits.length > 10) {
    return digits.slice(-10);
  }
  return digits;
}

function normalizeHandleForCompare(value?: string): string {
  return (value || "").trim().toLowerCase().replace(/^@+/, "");
}

function normalizeNameForCompare(value?: string): string {
  return (value || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isOwnerNameValue(value: string | undefined, owner: AdminOwnerIdentity): boolean {
  const current = normalizeNameForCompare(value);
  if (!current) return false;
  const ownerName = normalizeNameForCompare(owner.name);
  if (!ownerName) return false;
  if (current === ownerName) return true;

  const ownerParts = ownerName.split(" ").filter(Boolean);
  const first = ownerParts[0] || "";
  const last = ownerParts[ownerParts.length - 1] || "";
  if (first && current === first) return true;
  if (last && current === last) return true;
  if (current.includes("dj anupya")) return true;
  return false;
}

function isOwnerEmailValue(value: string | undefined, owner: AdminOwnerIdentity): boolean {
  const current = normalizeProfileEmail(value);
  const ownerEmail = normalizeProfileEmail(owner.email);
  return Boolean(current && ownerEmail && current === ownerEmail);
}

function isOwnerPhoneValue(value: string | undefined, owner: AdminOwnerIdentity): boolean {
  const current = normalizePhoneForCompare(value);
  const ownerPhone = normalizePhoneForCompare(owner.phone);
  return Boolean(current && ownerPhone && current === ownerPhone);
}

function isOwnerInstagramValue(value: string | undefined, owner: AdminOwnerIdentity): boolean {
  const current = normalizeHandleForCompare(value);
  const ownerIg = normalizeHandleForCompare(owner.instagramHandle);
  return Boolean(current && ownerIg && current === ownerIg);
}

function sanitizeExtractedAgainstOwner(extracted: ExtractedInquiry, owner: AdminOwnerIdentity): ExtractedInquiry {
  const next: ExtractedInquiry = { ...extracted };
  if (isOwnerNameValue(next.clientName, owner)) {
    next.clientName = undefined;
  }
  if (isOwnerEmailValue(next.email, owner)) {
    next.email = undefined;
  }
  if (isOwnerPhoneValue(next.phone, owner)) {
    next.phone = undefined;
  }
  if (isOwnerInstagramValue(next.instagramHandle, owner)) {
    next.instagramHandle = undefined;
  }
  return next;
}

function sanitizeWorkspaceProfileAgainstOwner(profile: WorkspaceProfile, owner: AdminOwnerIdentity): WorkspaceProfile {
  const next: WorkspaceProfile = structuredClone(profile);
  const nameKeys: Array<keyof WorkspaceProfile> = [
    "primaryClientName",
    "secondaryClientName",
    "weddingPlannerName",
    "avVendorName",
  ];
  const emailKeys: Array<keyof WorkspaceProfile> = [
    "primaryEmail",
    "secondaryEmail",
    "weddingPlannerEmail",
    "avVendorEmail",
  ];
  const phoneKeys: Array<keyof WorkspaceProfile> = [
    "primaryPhone",
    "secondaryPhone",
    "weddingPlannerPhone",
    "avVendorPhone",
  ];
  const igKeys: Array<keyof WorkspaceProfile> = [
    "primaryInstagramHandle",
    "secondaryInstagramHandle",
    "weddingPlannerInstagramHandle",
    "avVendorInstagramHandle",
  ];

  for (const key of nameKeys) {
    if (isOwnerNameValue(next[key] as string | undefined, owner)) {
      (next[key] as string) = "";
    }
  }
  for (const key of emailKeys) {
    if (isOwnerEmailValue(next[key] as string | undefined, owner)) {
      (next[key] as string) = "";
    }
  }
  for (const key of phoneKeys) {
    if (isOwnerPhoneValue(next[key] as string | undefined, owner)) {
      (next[key] as string) = "";
    }
  }
  for (const key of igKeys) {
    if (isOwnerInstagramValue(next[key] as string | undefined, owner)) {
      (next[key] as string) = "";
    }
  }
  return next;
}

function sanitizeClientAgainstOwner(client: Client, owner: AdminOwnerIdentity): void {
  if (isOwnerNameValue(client.fullName, owner)) {
    client.fullName = "Unknown Client";
  }
  if (isOwnerEmailValue(client.email, owner)) {
    client.email = "";
  }
  if (isOwnerPhoneValue(client.phone, owner)) {
    client.phone = undefined;
  }
  if (isOwnerInstagramValue(client.instagramHandle, owner)) {
    client.instagramHandle = undefined;
  }
  client.secondaryEmails = (client.secondaryEmails || []).filter((email) => !isOwnerEmailValue(email, owner));
}

function defaultWorkspaceProfile(args: {
  client?: Client;
  event?: Event;
  extracted?: ExtractedInquiry;
  existing?: WorkspaceProfile;
}): WorkspaceProfile {
  const existing = args.existing;
  const clientName = normalizeProfileText(args.client?.fullName);
  const clientEmail = isKnownClientEmail(args.client?.email) ? normalizeProfileEmail(args.client?.email) : "";
  const clientPhone = normalizeProfilePhone(args.client?.phone);
  const clientInstagram = normalizeInstagramHandle(args.client?.instagramHandle) || "";
  return {
    primaryClientName:
      clientName ||
      normalizeProfileText(existing?.primaryClientName) ||
      normalizeProfileText(args.extracted?.clientName) ||
      "",
    primaryEmail:
      clientEmail ||
      normalizeProfileEmail(existing?.primaryEmail) ||
      normalizeProfileEmail(args.extracted?.email) ||
      "",
    primaryPhone:
      clientPhone ||
      normalizeProfilePhone(existing?.primaryPhone) ||
      normalizeProfilePhone(args.extracted?.phone) ||
      "",
    primaryInstagramHandle:
      clientInstagram ||
      normalizeInstagramHandle(existing?.primaryInstagramHandle) ||
      normalizeInstagramHandle(args.extracted?.instagramHandle) ||
      "",
    secondaryClientName: normalizeProfileText(existing?.secondaryClientName),
    secondaryEmail: normalizeProfileEmail(existing?.secondaryEmail),
    secondaryPhone: normalizeProfilePhone(existing?.secondaryPhone),
    secondaryInstagramHandle: normalizeInstagramHandle(existing?.secondaryInstagramHandle) || "",
    weddingPlannerName: normalizeProfileText(existing?.weddingPlannerName),
    weddingPlannerEmail: normalizeProfileEmail(existing?.weddingPlannerEmail),
    weddingPlannerPhone: normalizeProfilePhone(existing?.weddingPlannerPhone),
    weddingPlannerInstagramHandle: normalizeInstagramHandle(existing?.weddingPlannerInstagramHandle) || "",
    avVendorName: normalizeProfileText(existing?.avVendorName),
    avVendorEmail: normalizeProfileEmail(existing?.avVendorEmail),
    avVendorPhone: normalizeProfilePhone(existing?.avVendorPhone),
    avVendorInstagramHandle: normalizeInstagramHandle(existing?.avVendorInstagramHandle) || "",
    customFields: (existing?.customFields || [])
      .map((item) => ({
        key: normalizeProfileText(item?.key),
        value: normalizeProfileText(item?.value),
      }))
      .filter((item) => item.key || item.value),
  };
}

function mergeWorkspaceProfile(base: WorkspaceProfile, patch?: Partial<WorkspaceProfile>): WorkspaceProfile {
  if (!patch) return base;
  const merged: WorkspaceProfile = {
    ...base,
    primaryClientName: normalizeProfileText(patch.primaryClientName ?? base.primaryClientName),
    primaryEmail: normalizeProfileEmail(patch.primaryEmail ?? base.primaryEmail),
    primaryPhone: normalizeProfilePhone(patch.primaryPhone ?? base.primaryPhone),
    primaryInstagramHandle: normalizeInstagramHandle(patch.primaryInstagramHandle ?? base.primaryInstagramHandle) || "",
    secondaryClientName: normalizeProfileText(patch.secondaryClientName ?? base.secondaryClientName),
    secondaryEmail: normalizeProfileEmail(patch.secondaryEmail ?? base.secondaryEmail),
    secondaryPhone: normalizeProfilePhone(patch.secondaryPhone ?? base.secondaryPhone),
    secondaryInstagramHandle:
      normalizeInstagramHandle(patch.secondaryInstagramHandle ?? base.secondaryInstagramHandle) || "",
    weddingPlannerName: normalizeProfileText(patch.weddingPlannerName ?? base.weddingPlannerName),
    weddingPlannerEmail: normalizeProfileEmail(patch.weddingPlannerEmail ?? base.weddingPlannerEmail),
    weddingPlannerPhone: normalizeProfilePhone(patch.weddingPlannerPhone ?? base.weddingPlannerPhone),
    weddingPlannerInstagramHandle:
      normalizeInstagramHandle(patch.weddingPlannerInstagramHandle ?? base.weddingPlannerInstagramHandle) || "",
    avVendorName: normalizeProfileText(patch.avVendorName ?? base.avVendorName),
    avVendorEmail: normalizeProfileEmail(patch.avVendorEmail ?? base.avVendorEmail),
    avVendorPhone: normalizeProfilePhone(patch.avVendorPhone ?? base.avVendorPhone),
    avVendorInstagramHandle: normalizeInstagramHandle(patch.avVendorInstagramHandle ?? base.avVendorInstagramHandle) || "",
    customFields: base.customFields,
  };
  if (Array.isArray(patch.customFields)) {
    merged.customFields = patch.customFields
      .map((item) => ({
        key: normalizeProfileText(item?.key),
        value: normalizeProfileText(item?.value),
      }))
      .filter((item) => item.key || item.value);
  }
  return merged;
}

function maybeUpdateByRole(args: {
  profile: WorkspaceProfile;
  role: "weddingPlanner" | "avVendor";
  text: string;
}) {
  const roleLabel = args.role === "weddingPlanner" ? "(?:wedding\\s+planner|planner|coordinator)" : "(?:av\\s+vendor|av|audio\\s*visual|sound\\s+vendor)";
  const nameMatch = args.text.match(
    new RegExp(`${roleLabel}\\s*[:\\-]?\\s*([A-Za-z][A-Za-z .'-]{1,80})(?=\\s*(?:<|\\(|\\n|$|,))`, "i")
  )?.[1];
  const emailMatch = args.text.match(
    new RegExp(`${roleLabel}[\\s\\S]{0,120}?\\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,})\\b`, "i")
  )?.[1];
  const phoneMatch = args.text.match(
    new RegExp(`${roleLabel}[\\s\\S]{0,120}?(\\+?\\d[\\d\\s().-]{8,}\\d)`, "i")
  )?.[1];
  const igMatch = args.text.match(
    new RegExp(`${roleLabel}[\\s\\S]{0,120}?@([a-z0-9._]{2,30})\\b`, "i")
  )?.[1];

  if (args.role === "weddingPlanner") {
    if (nameMatch) args.profile.weddingPlannerName = normalizeProfileText(nameMatch);
    if (emailMatch) args.profile.weddingPlannerEmail = normalizeProfileEmail(emailMatch);
    if (phoneMatch) args.profile.weddingPlannerPhone = normalizeProfilePhone(phoneMatch);
    if (igMatch) args.profile.weddingPlannerInstagramHandle = normalizeInstagramHandle(igMatch) || args.profile.weddingPlannerInstagramHandle;
  } else {
    if (nameMatch) args.profile.avVendorName = normalizeProfileText(nameMatch);
    if (emailMatch) args.profile.avVendorEmail = normalizeProfileEmail(emailMatch);
    if (phoneMatch) args.profile.avVendorPhone = normalizeProfilePhone(phoneMatch);
    if (igMatch) args.profile.avVendorInstagramHandle = normalizeInstagramHandle(igMatch) || args.profile.avVendorInstagramHandle;
  }
}

function inferWorkspaceProfileHeuristic(args: {
  rawText: string;
  base: WorkspaceProfile;
}): WorkspaceProfile {
  const text = (args.rawText || "").replace(/\r/g, "\n");
  const profile = defaultWorkspaceProfile({ existing: args.base });

  const coupleHeader = text.match(
    /(?:^|\n)\s*([A-Za-z][A-Za-z.'-]+(?:\s+[A-Za-z][A-Za-z.'-]+)?)\s+(?:and|&)\s+([A-Za-z][A-Za-z.'-]+(?:\s+[A-Za-z][A-Za-z.'-]+)?)(?:\s*<\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\s*>)?/i
  );
  if (coupleHeader) {
    if (!profile.primaryClientName || /\s+(and|&)\s+/i.test(profile.primaryClientName)) {
      profile.primaryClientName = normalizeProfileText(coupleHeader[1]);
    }
    if (!profile.secondaryClientName) {
      profile.secondaryClientName = normalizeProfileText(coupleHeader[2]);
    }
    if (!profile.primaryEmail && coupleHeader[3]) profile.primaryEmail = normalizeProfileEmail(coupleHeader[3]);
  }

  const toName = text.match(/(?:^|\n)\s*to:\s*([A-Za-z][A-Za-z .'-]{1,60})/i)?.[1];
  if (toName && !profile.primaryClientName) {
    profile.primaryClientName = normalizeProfileText(toName);
  }

  maybeUpdateByRole({ profile, role: "weddingPlanner", text });
  maybeUpdateByRole({ profile, role: "avVendor", text });

  const customCandidates: Array<{ key: string; value: string }> = [];
  const labelPairs = [...text.matchAll(/(?:^|\n)\s*[•*]?\s*([A-Za-z][A-Za-z /&-]{2,40})\s*:\s*([^\n]{2,160})/g)];
  for (const pair of labelPairs) {
    const key = normalizeProfileText(pair[1]);
    const value = normalizeProfileText(pair[2]);
    if (!key || !value) continue;
    if (/^(event type|date|location|services|timeline|subject|to)$/i.test(key)) continue;
    customCandidates.push({ key, value });
  }
  if (customCandidates.length) {
    const mergedMap = new Map<string, string>();
    for (const field of profile.customFields) {
      if (!field.key) continue;
      mergedMap.set(field.key.toLowerCase(), field.value);
    }
    for (const field of customCandidates) {
      mergedMap.set(field.key.toLowerCase(), field.value);
    }
    profile.customFields = Array.from(mergedMap.entries()).map(([key, value]) => ({
      key: key
        .split(" ")
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" "),
      value,
    }));
  }

  return profile;
}

async function refreshWorkspaceProfileFromContext(args: {
  event: Event;
  client: Client;
  extracted: ExtractedInquiry;
  rawText: string;
  ownerIdentity: AdminOwnerIdentity;
}) {
  let profile = defaultWorkspaceProfile({
    existing: args.event.profile,
    client: args.client,
    event: args.event,
    extracted: args.extracted,
  });
  profile = inferWorkspaceProfileHeuristic({
    rawText: args.rawText,
    base: profile,
  });

  const codexProfileResult = await extractWorkspaceProfileWithCodex({
    rawText: args.rawText,
    existingProfile: profile,
    ownerIdentity: args.ownerIdentity,
  });
  if (codexProfileResult.profile && Object.keys(codexProfileResult.profile).length) {
    profile = mergeWorkspaceProfile(profile, codexProfileResult.profile);
    if (shouldUseCodexForAdmin()) {
      args.event.latestNotes = `${args.event.latestNotes ? `${args.event.latestNotes} ` : ""}[profile:${codexSignalLabel(codexProfileResult.mode)}:${codexProfileResult.model}]`;
    }
  }

  args.event.profile = sanitizeWorkspaceProfileAgainstOwner(profile, args.ownerIdentity);
  syncPrimaryProfileToClient({
    client: args.client,
    event: args.event,
    profile: args.event.profile,
  });
  sanitizeClientAgainstOwner(args.client, args.ownerIdentity);
}

function syncPrimaryProfileToClient(args: {
  client: Client;
  event: Event;
  profile: WorkspaceProfile;
}): void {
  const profile = args.event.profile || args.profile;
  args.event.profile = profile;

  const nextName = normalizeProfileText(args.profile.primaryClientName);
  if (nextName) {
    args.client.fullName = nextName;
    profile.primaryClientName = nextName;
  }

  const currentPrimaryEmail = normalizeProfileEmail(args.client.email);
  const nextPrimaryEmail = normalizeProfileEmail(args.profile.primaryEmail);
  if (isKnownClientEmail(nextPrimaryEmail)) {
    if (
      isKnownClientEmail(currentPrimaryEmail) &&
      currentPrimaryEmail !== nextPrimaryEmail &&
      !args.client.secondaryEmails.includes(currentPrimaryEmail)
    ) {
      args.client.secondaryEmails.push(currentPrimaryEmail);
    }
    args.client.email = nextPrimaryEmail;
    profile.primaryEmail = nextPrimaryEmail;
  } else {
    args.client.email = "";
    profile.primaryEmail = "";
  }

  const nextPhone = normalizeProfilePhone(args.profile.primaryPhone);
  args.client.phone = nextPhone || undefined;
  profile.primaryPhone = nextPhone;

  const nextInstagram = normalizeInstagramHandle(args.profile.primaryInstagramHandle);
  args.client.instagramHandle = nextInstagram;
  profile.primaryInstagramHandle = nextInstagram || "";

  const normalizedPrimary = normalizeProfileEmail(args.client.email);
  args.client.secondaryEmails = Array.from(
    new Set((args.client.secondaryEmails || []).map((value) => normalizeProfileEmail(value)).filter(Boolean))
  ).filter((value) => value !== normalizedPrimary);
}

function hasRequiredWorkspaceContact(extracted: ExtractedInquiry): boolean {
  const email = isKnownClientEmail(extracted.email);
  const phone = Boolean((extracted.phone || "").trim());
  const instagram = Boolean(normalizeInstagramHandle(extracted.instagramHandle));
  return email || phone || instagram;
}

function hasUsableClientName(value?: string): boolean {
  const normalized = normalizeNameForCompare(value);
  if (!normalized) return false;
  if (normalized === "unknown client") return false;
  return normalized.length >= 2;
}

function hasWorkspaceCreationIdentity(extracted: ExtractedInquiry): boolean {
  return hasRequiredWorkspaceContact(extracted);
}

function primaryClientContact(client: Client): string {
  if (isKnownClientEmail(client.email)) return client.email;
  if ((client.phone || "").trim()) return client.phone!.trim();
  if ((client.instagramHandle || "").trim()) return client.instagramHandle!.trim();
  const fallback = client.secondaryEmails.find((item) => isKnownClientEmail(item));
  return fallback || "-";
}

function workspaceTitleLabel(args: {
  clientName?: string;
  eventType?: string;
  eventDate?: string;
  eventDateTimestamp?: number;
  workspaceStartTimestamp?: number;
}): string {
  const normalizedName = (args.clientName || "Client").trim();
  const firstName = normalizedName.split(/\s+/).filter(Boolean)[0] || "Client";
  const eventType = (args.eventType || "Event").trim();
  const when = formatDateLong({
    isoDate: timestampToIsoDate(args.workspaceStartTimestamp) || args.eventDate,
    timestamp: normalizeTimestamp(args.workspaceStartTimestamp) || args.eventDateTimestamp,
    fallback: "TBD",
  });
  const possessive = firstName.toLowerCase().endsWith("s") ? `${firstName}'` : `${firstName}'s`;
  return `${possessive} ${eventType} on ${when}`;
}

function latestContextSummaryForList(rawFeed: string): string {
  const latest = latestContextFromRawFeed(rawFeed || "").replace(/\s+/g, " ").trim();
  if (!latest) return "No recent context.";
  if (latest.length <= 160) return latest;
  return `${latest.slice(0, 157)}...`;
}

function normalizeNameToken(value?: string): string {
  return (value || "")
    .toLowerCase()
    .replace(/[^a-z\s.'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nameParts(value?: string): string[] {
  const normalized = normalizeNameToken(value);
  if (!normalized) return [];
  return normalized.split(" ").filter(Boolean);
}

function isAbbreviatedName(value?: string): boolean {
  const parts = nameParts(value);
  if (!parts.length) return false;
  return parts.some((part) => part.length <= 1 || /^[a-z]\.?$/i.test(part));
}

function shouldReplaceClientName(currentName: string | undefined, candidateName: string | undefined): boolean {
  const current = (currentName || "").trim();
  const candidate = (candidateName || "").trim();
  if (!candidate) return false;
  if (!current || current === "Unknown Client") return true;

  const currentNorm = normalizeNameToken(current);
  const candidateNorm = normalizeNameToken(candidate);
  if (!candidateNorm || currentNorm === candidateNorm) return false;

  const currentParts = nameParts(currentNorm);
  const candidateParts = nameParts(candidateNorm);
  if (!currentParts.length) return true;
  if (!candidateParts.length) return false;

  if (currentParts.length === 1 && candidateParts.length >= 2) {
    return candidateParts[0] === currentParts[0];
  }

  if (candidateParts.length > currentParts.length) {
    return candidateParts.some((part) => currentParts.includes(part));
  }

  if (isAbbreviatedName(current) && !isAbbreviatedName(candidate) && candidateParts.length >= currentParts.length) {
    return true;
  }

  return false;
}

function mergeClientProfileFromExtracted(args: {
  client: Client;
  extracted: ExtractedInquiry;
}): void {
  const nextName = (args.extracted.clientName || "").trim();
  if (shouldReplaceClientName(args.client.fullName, nextName)) {
    args.client.fullName = nextName;
  }

  const nextEmail = (args.extracted.email || "").trim().toLowerCase();
  if (nextEmail) {
    const currentPrimary = (args.client.email || "").trim().toLowerCase();
    if (!isKnownClientEmail(currentPrimary)) {
      args.client.email = nextEmail;
    } else if (currentPrimary !== nextEmail && !args.client.secondaryEmails.includes(nextEmail)) {
      args.client.secondaryEmails.push(nextEmail);
    }
  }

  if (args.extracted.phone && !args.client.phone) {
    args.client.phone = args.extracted.phone;
  }
  const nextHandle = normalizeInstagramHandle(args.extracted.instagramHandle);
  if (isKnownClientEmail(args.extracted.email)) {
    args.client.instagramHandle = undefined;
  } else if (nextHandle && !args.client.instagramHandle) {
    args.client.instagramHandle = nextHandle;
  }

  if (isSafeLocationValue(args.extracted.location) && !args.client.location) {
    args.client.location = args.extracted.location;
  }

  const primary = (args.client.email || "").trim().toLowerCase();
  args.client.secondaryEmails = Array.from(
    new Set((args.client.secondaryEmails || []).map((value) => value.trim().toLowerCase()).filter(Boolean))
  ).filter((value) => value !== primary);
}

function contractHasTimeline(contract?: Contract): boolean {
  if (!contract) return false;
  return contract.dynamicFields.eventDetails.some((row) => Boolean((row.time || "").trim()));
}

function mergeEventProfileFromExtracted(args: {
  event: Event;
  extracted: ExtractedInquiry;
}): void {
  const { event, extracted } = args;

  event.eventType = extracted.eventType || event.eventType;
  event.eventDate = extracted.eventDate || event.eventDate;
  event.eventDateTimestamp = extracted.eventDateTimestamp || event.eventDateTimestamp;
  event.venue = isSafeLocationValue(extracted.location) ? extracted.location : event.venue;
  event.guestCount = extracted.guestCount || event.guestCount;
  event.duration =
    extracted.duration ||
    (extracted.timelineSegments || [])
      .map((item) => item.time)
      .filter(Boolean)
      .join("; ") ||
    event.duration;
  event.servicesRequested = Array.from(new Set([...(event.servicesRequested || []), ...extracted.servicesRequested]));
}

function withWorkspaceContextExtracted(args: {
  extracted: ExtractedInquiry;
  client: Client;
  event: Event;
  contract?: Contract;
}): ExtractedInquiry {
  const boundsLocked = args.event.workspaceDateBoundsLocked === true;
  const profile = defaultWorkspaceProfile({
    existing: args.event.profile,
    client: args.client,
    event: args.event,
  });
  const contractPrimary = args.contract?.dynamicFields.eventDetails[0];
  const fallbackEmail = isKnownClientEmail(profile.primaryEmail)
    ? profile.primaryEmail
    : isKnownClientEmail(args.client.email)
      ? args.client.email
      : undefined;
  const fallbackPhone = normalizeProfilePhone(profile.primaryPhone) || args.client.phone;
  const fallbackInstagram = normalizeInstagramHandle(profile.primaryInstagramHandle) || normalizeInstagramHandle(args.client.instagramHandle);
  const mergedEventDate = boundsLocked
    ? timestampToIsoDate(args.event.workspaceStartTimestamp) ||
      args.extracted.eventDate ||
      args.event.eventDate
    : args.extracted.eventDate ||
      timestampToIsoDate(args.event.workspaceStartTimestamp) ||
      args.event.eventDate;
  const mergedEventDateTimestamp =
    (boundsLocked
      ? normalizeTimestamp(args.event.workspaceStartTimestamp)
      : undefined) ||
    parseDateToTimestamp(mergedEventDate) ||
    normalizeTimestamp(args.extracted.eventDateTimestamp) ||
    normalizeTimestamp(args.event.workspaceStartTimestamp) ||
    normalizeTimestamp(args.event.eventDateTimestamp);
  const mergedEventEndDate = boundsLocked
    ? timestampToIsoDate(args.event.workspaceEndTimestamp) ||
      args.extracted.eventEndDate ||
      mergedEventDate ||
      args.event.eventDate
    : args.extracted.eventEndDate ||
      timestampToIsoDate(args.event.workspaceEndTimestamp) ||
      mergedEventDate ||
      args.event.eventDate;
  const mergedEventEndDateTimestamp =
    (boundsLocked
      ? normalizeTimestamp(args.event.workspaceEndTimestamp)
      : undefined) ||
    parseDateToTimestamp(mergedEventEndDate) ||
    normalizeTimestamp(args.extracted.eventEndDateTimestamp) ||
    normalizeTimestamp(args.event.workspaceEndTimestamp) ||
    mergedEventDateTimestamp;

  const next: ExtractedInquiry = {
    ...args.extracted,
    email: args.extracted.email || fallbackEmail,
    phone: args.extracted.phone || fallbackPhone,
    instagramHandle: normalizeInstagramHandle(args.extracted.instagramHandle) || fallbackInstagram,
    eventDate: timestampToIsoDate(mergedEventDateTimestamp) || mergedEventDate,
    eventDateTimestamp: mergedEventDateTimestamp,
    eventEndDate: timestampToIsoDate(mergedEventEndDateTimestamp) || mergedEventEndDate,
    eventEndDateTimestamp: mergedEventEndDateTimestamp,
    location: args.event.venue || args.extracted.location || contractPrimary?.location,
    duration: args.extracted.duration || args.event.duration,
    servicesRequested: Array.from(new Set([...(args.event.servicesRequested || []), ...args.extracted.servicesRequested])),
    timelineSegments: args.extracted.timelineSegments?.length ? args.extracted.timelineSegments : [],
    missingFields: [...args.extracted.missingFields],
  };

  const missing = new Set(next.missingFields);
  if (next.email || next.phone || next.instagramHandle) missing.delete("email");
  if (next.eventDateTimestamp || next.eventDate) missing.delete("event_date");
  if (next.location) missing.delete("location");
  if (next.servicesRequested.length) missing.delete("services_requested");
  if (next.duration || next.timelineSegments?.length || contractHasTimeline(args.contract)) missing.delete("event_time");
  next.missingFields = Array.from(missing);

  return next;
}

function buildEmailConfirmedDetails(args: {
  client: Client;
  event: Event;
  contract?: Contract;
  extracted: ExtractedInquiry;
}): {
  email?: string;
  location?: string;
  eventDate?: string;
  services?: string[];
  timeline?: string;
} {
  const timelineFromExtracted = (args.extracted.timelineSegments || [])
    .map((segment) => `${segment.title}: ${segment.time}`)
    .filter(Boolean)
    .join("; ");
  const timelineFromContract = (args.contract?.dynamicFields.eventDetails || [])
    .map((row) => row.time)
    .filter(Boolean)
    .join("; ");
  const profile = defaultWorkspaceProfile({
    existing: args.event.profile,
    client: args.client,
    event: args.event,
  });
  const boundsLocked = args.event.workspaceDateBoundsLocked === true;
  const canonicalEventDate = boundsLocked
    ? timestampToIsoDate(args.event.workspaceStartTimestamp) ||
      args.event.eventDate ||
      args.extracted.eventDate ||
      args.contract?.dynamicFields.eventDetails[0]?.date
    : args.extracted.eventDate ||
      args.event.eventDate ||
      timestampToIsoDate(args.event.workspaceStartTimestamp) ||
      args.contract?.dynamicFields.eventDetails[0]?.date;

  return {
    email:
      (isKnownClientEmail(profile.primaryEmail) ? profile.primaryEmail : undefined) ||
      args.extracted.email ||
      (isKnownClientEmail(args.client.email) ? args.client.email : undefined),
    location: args.event.venue || args.extracted.location || args.contract?.dynamicFields.eventDetails[0]?.location,
    eventDate: canonicalEventDate,
    services: Array.from(new Set([...(args.event.servicesRequested || []), ...(args.extracted.servicesRequested || [])])),
    timeline: timelineFromExtracted || args.extracted.duration || timelineFromContract || args.event.duration,
  };
}

function contractReadyToSend(args: {
  contract?: Contract;
  missingFields: string[];
}): boolean {
  if (!args.contract) return false;
  if (args.missingFields.length > 0) return false;
  if ((args.contract.dynamicFields.totalAmount || 0) <= 0) return false;
  const first = args.contract.dynamicFields.eventDetails[0];
  if (!first) return false;
  return Boolean(first.date && first.time && first.location);
}

function isSameDay(a?: number, b?: number): boolean {
  const aTs = normalizeTimestamp(a);
  const bTs = normalizeTimestamp(b);
  if (!aTs || !bTs) return false;
  return Math.floor(aTs / 86400000) === Math.floor(bTs / 86400000);
}

type DateAvailabilityStatus = "available" | "unavailable_other_booking";

interface TimeWindow {
  start: number;
  end: number;
}

function dayBoundsFromTimestamp(timestamp: number): TimeWindow {
  const day = new Date(timestamp);
  day.setHours(0, 0, 0, 0);
  const start = day.getTime();
  const end = start + 24 * 60 * 60000 - 1;
  return { start, end };
}

function normalizeWindow(window?: Partial<TimeWindow>): TimeWindow | undefined {
  const start = normalizeTimestamp(window?.start);
  const end = normalizeTimestamp(window?.end);
  if (typeof start !== "number") return undefined;
  if (typeof end === "number" && end >= start) {
    return { start, end };
  }
  return dayBoundsFromTimestamp(start);
}

function windowsOverlap(a: TimeWindow, b: TimeWindow): boolean {
  return a.start <= b.end && b.start <= a.end;
}

function resolveEventWindow(event: Event): TimeWindow | undefined {
  const workspaceStart = normalizeTimestamp(event.workspaceStartTimestamp);
  const workspaceEnd = normalizeTimestamp(event.workspaceEndTimestamp);
  if (typeof workspaceStart === "number" && typeof workspaceEnd === "number" && workspaceEnd >= workspaceStart) {
    return { start: workspaceStart, end: workspaceEnd };
  }

  const dateTs = parseDateToTimestamp(event.eventDate) || normalizeTimestamp(event.eventDateTimestamp);
  if (typeof dateTs !== "number") return undefined;
  const day = new Date(dateTs);
  day.setHours(0, 0, 0, 0);
  const dayStart = day.getTime();

  const parsedDuration = parseTimeRangeMinutes(event.duration);
  if (!parsedDuration) {
    return dayBoundsFromTimestamp(dayStart);
  }

  const { start, end } = windowFromDateAndRange(dayStart, parsedDuration);
  return { start, end };
}

function resolveExtractedWindow(args: {
  extracted: ExtractedInquiry;
  fallbackEvent: Event;
}): TimeWindow | undefined {
  const extractedStart = parseDateToTimestamp(args.extracted.eventDate) || normalizeTimestamp(args.extracted.eventDateTimestamp);
  const extractedEnd = parseDateToTimestamp(args.extracted.eventEndDate) || normalizeTimestamp(args.extracted.eventEndDateTimestamp);

  const parsedTimelineWindows: TimeWindow[] = [];
  for (const segment of args.extracted.timelineSegments || []) {
    const segmentDateTs = parseDateToTimestamp(segment.date || args.extracted.eventDate) || extractedStart;
    if (typeof segmentDateTs !== "number") continue;
    const parsedRange = parseTimeRangeMinutes(segment.time);
    if (!parsedRange) continue;
    const { start, end } = windowFromDateAndRange(segmentDateTs, parsedRange);
    parsedTimelineWindows.push({ start, end });
  }
  if (parsedTimelineWindows.length) {
    const start = Math.min(...parsedTimelineWindows.map((item) => item.start));
    const end = Math.max(...parsedTimelineWindows.map((item) => item.end));
    return { start, end };
  }

  if (typeof extractedStart === "number") {
    const parsedDuration = parseTimeRangeMinutes(args.extracted.duration);
    if (parsedDuration) {
      const { start, end } = windowFromDateAndRange(extractedStart, parsedDuration);
      return { start, end };
    }

    const startDay = new Date(extractedStart);
    startDay.setHours(0, 0, 0, 0);
    const start = startDay.getTime();
    if (typeof extractedEnd === "number" && extractedEnd >= extractedStart) {
      const endDay = new Date(extractedEnd);
      endDay.setHours(23, 59, 59, 999);
      return { start, end: endDay.getTime() };
    }
    return dayBoundsFromTimestamp(start);
  }

  return resolveEventWindow(args.fallbackEvent);
}

function classifyDateAvailabilityFromWorkspaces(args: {
  store: AdminStore;
  targetEventId: string;
  extracted: ExtractedInquiry;
  fallbackEvent: Event;
}): DateAvailabilityStatus {
  const targetWindow = normalizeWindow(resolveExtractedWindow({
    extracted: args.extracted,
    fallbackEvent: args.fallbackEvent,
  }));
  if (!targetWindow) return "available";

  for (const item of args.store.events) {
    if (item.id === args.targetEventId) continue;
    const itemWindow = normalizeWindow(resolveEventWindow(item));
    if (!itemWindow) continue;
    if (!windowsOverlap(itemWindow, targetWindow)) continue;
    if (item.status === "cancelled") continue;

    const itemContract = getLatestContract(args.store, item.id);
    const itemInvoice = getInvoiceByEvent(args.store, item.id);
    const itemStage = detectStage(item, itemContract, itemInvoice);
    if (itemStage === "in_contract" || itemStage === "execution") {
      return "unavailable_other_booking";
    }
  }

  return "available";
}

function dayStartTimestamp(value?: number): number | undefined {
  const normalized = normalizeTimestamp(value);
  if (!normalized) return undefined;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return undefined;
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function explicitDateMentions(text: string): number[] {
  if (!text) return [];
  const patterns = [
    /\b(?:january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{2,4})?\b/gi,
    /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g,
    /\b\d{4}-\d{2}-\d{2}\b/g,
  ];
  const dayTs = new Set<number>();

  for (const pattern of patterns) {
    let match: RegExpExecArray | null = pattern.exec(text);
    while (match) {
      const parsed = parseDateToTimestamp(match[0]);
      const day = dayStartTimestamp(parsed);
      if (typeof day === "number") {
        dayTs.add(day);
      }
      match = pattern.exec(text);
    }
  }

  return Array.from(dayTs);
}

function draftConflictsWithCanonicalEventDate(draft: string, extracted: ExtractedInquiry): boolean {
  const startDay =
    dayStartTimestamp(parseDateToTimestamp(extracted.eventDate)) ||
    dayStartTimestamp(extracted.eventDateTimestamp);
  if (typeof startDay !== "number") return false;

  const endDay =
    dayStartTimestamp(parseDateToTimestamp(extracted.eventEndDate)) ||
    dayStartTimestamp(extracted.eventEndDateTimestamp) ||
    startDay;
  const windowStart = Math.min(startDay, endDay);
  const windowEnd = Math.max(startDay, endDay);

  const mentionedDays = explicitDateMentions(draft);
  if (!mentionedDays.length) return false;
  if (!mentionedDays.includes(startDay)) {
    return true;
  }
  return mentionedDays.some((day) => day < windowStart || day > windowEnd);
}

function enforceDraftDateConsistency(args: {
  draft: string;
  fallbackDraft: string;
  extracted: ExtractedInquiry;
}): string {
  if (!args.draft.trim()) return args.fallbackDraft;
  if (!draftConflictsWithCanonicalEventDate(args.draft, args.extracted)) {
    return args.draft;
  }
  return args.fallbackDraft;
}

function draftMentionsAvailabilityStatus(draft: string, status: DateAvailabilityStatus): boolean {
  const text = (draft || "").toLowerCase();
  if (status === "available") return true;
  return /(not available|already confirmed|already booked|unavailable)/i.test(text);
}

function normalizeDraftWhitespace(value: string): string {
  return value
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripUnconfirmedInquiryAvailabilityLanguage(value: string): string {
  const lines = (value || "").split("\n");
  const filtered = lines.filter(
    (line) => !/(another inquiry|not confirmed yet|still tentatively available)/i.test(line)
  );
  const compact = filtered.join("\n");
  const sentencesStripped = compact
    .replace(/I do have another inquiry[^.?!]*[.?!]?\s*/gi, "")
    .replace(/there is another inquiry[^.?!]*[.?!]?\s*/gi, "");
  return normalizeDraftWhitespace(sentencesStripped);
}

function stripGenericAvailabilityLanguage(value: string): string {
  const lines = (value || "").split("\n");
  const filtered = lines.filter(
    (line) =>
      !/(tentatively open|tentatively available|tentatively unavailable|currently available on|currently open on)/i.test(line)
  );
  const compact = filtered.join("\n");
  return normalizeDraftWhitespace(compact);
}

function enforceDraftAvailabilityConsistency(args: {
  draft: string;
  fallbackDraft: string;
  dateAvailabilityStatus: DateAvailabilityStatus;
  availabilityAlreadyShared?: boolean;
}): string {
  let draft = args.draft || "";
  let fallbackDraft = args.fallbackDraft || "";

  if (args.dateAvailabilityStatus !== "unavailable_other_booking") {
    draft = stripUnconfirmedInquiryAvailabilityLanguage(draft);
    fallbackDraft = stripUnconfirmedInquiryAvailabilityLanguage(fallbackDraft);
  }

  if (args.dateAvailabilityStatus === "available" && args.availabilityAlreadyShared) {
    draft = stripGenericAvailabilityLanguage(draft);
    fallbackDraft = stripGenericAvailabilityLanguage(fallbackDraft);
  }

  if (!draft.trim()) {
    return fallbackDraft;
  }
  if (draftMentionsAvailabilityStatus(draft, args.dateAvailabilityStatus)) {
    return draft;
  }
  return fallbackDraft;
}

function availabilityAlreadyCommunicated(rawFeed?: string): boolean {
  const blocks = approvedDraftBlocks(rawFeed || "");
  if (!blocks.length) return false;
  return blocks.some((text) => /(tentatively open|tentatively available|not available|unavailable|already confirmed on my calendar)/i.test(text));
}

function firstNameFromClient(fullName: string): string {
  const normalized = (fullName || "").trim();
  if (!normalized) return "";
  return normalized.split(/\s+/)[0] || normalized;
}

function analyzeLatestContext(latestContext: string): {
  asksInclusions: boolean;
  asksPricing: boolean;
  asksExtraServices: boolean;
  mentionedExtraServices: string[];
  asksSetSamples: boolean;
  asksForCall: boolean;
  asksTravel: boolean;
  hasQuestion: boolean;
  hasTimelineUpdate: boolean;
} {
  const text = (latestContext || "").trim();
  const mentionedExtraServices: string[] = [];
  if (/\bdhol\b/i.test(text)) mentionedExtraServices.push("dhol players");
  if (/\bemcee\b|\bmc\b/i.test(text)) mentionedExtraServices.push("emcee support");
  if (/\blighting\b/i.test(text)) mentionedExtraServices.push("lighting");
  if (/\bbaraat\b/i.test(text)) mentionedExtraServices.push("baraat setup");

  const asksInclusions = /what(?:'s| is)? included|included in/i.test(text);
  const asksPricing = /(pricing|price|quote|cost|rate|\$\d)/i.test(text);
  const asksExtraServices = mentionedExtraServices.length > 0;
  const asksGenericExtraServices = /(additional services|extra services|other services)/i.test(text);
  const asksSetSamples =
    /(send|share).{0,30}(set|sample set|mix|playlist|demo|samples)/i.test(text) ||
    /(aligns?|aligned).{0,20}(genres?|music)/i.test(text);
  const asksForCall =
    /(hop on a call|schedule (?:a )?call|call and chat|chat more|discuss on a call|talk more|set up some time to meet|mutually convenient time)/i.test(
      text
    );
  const asksTravel = /(travel|hotel|flight|logistics)/i.test(text);
  const hasTimelineUpdate = /(timeline|(\d{1,2}:\d{2}\s*(?:am|pm)?\s*(?:-|–|—|to)\s*\d{1,2}:\d{2}\s*(?:am|pm)?))/i.test(text);
  const hasQuestion =
    text.includes("?") ||
    asksInclusions ||
    asksPricing ||
    asksExtraServices ||
    asksGenericExtraServices ||
    asksSetSamples ||
    asksForCall ||
    asksTravel;

  return {
    asksInclusions,
    asksPricing,
    asksExtraServices,
    mentionedExtraServices,
    asksSetSamples,
    asksForCall,
    asksTravel,
    hasQuestion,
    hasTimelineUpdate,
  };
}

function insertLineBeforeSignoff(draft: string, line: string): string {
  const trimmed = (draft || "").trim();
  if (!trimmed) return line;
  const signoffRegex = /\n\n(Best|Thanks|Warmly|Regards),\s*\nAnupya\s*$/i;
  if (signoffRegex.test(trimmed)) {
    return trimmed.replace(signoffRegex, `\n\n${line}\n\n$1,\nAnupya`);
  }
  return `${trimmed}\n\n${line}`;
}

function questionLikelyNeedsHumanIntervention(latestContext: string): boolean {
  const text = (latestContext || "").trim();
  if (!text) return false;
  const lowered = text.toLowerCase();
  const hasAskIntent =
    text.includes("?") ||
    /\b(can you|could you|would you|do you|please|possible to|let me know|share)\b/i.test(text);
  if (!hasAskIntent) return false;

  const highRiskTopics = [
    /\bcoi\b/i,
    /certificate of insurance/i,
    /\bw-?9\b/i,
    /\b1099\b/i,
    /\bmsa\b/i,
    /\bsow\b/i,
    /\bnda\b/i,
    /\bindemnif/i,
    /\bliability\b/i,
    /\bnet\s*30\b/i,
    /\binsurance\b/i,
    /\bsecurity clearance\b/i,
    /\bbackground check\b/i,
    /\bcontractual terms?\b/i,
  ];
  if (highRiskTopics.some((pattern) => pattern.test(text))) {
    return true;
  }

  const signals = analyzeLatestContext(text);
  const hasKnownCoverage =
    signals.asksInclusions ||
    signals.asksPricing ||
    signals.asksExtraServices ||
    signals.asksSetSamples ||
    signals.asksForCall ||
    signals.asksTravel ||
    signals.hasTimelineUpdate;

  if (!hasKnownCoverage && /\?/.test(text)) {
    return true;
  }

  // Questions about hard commitments/contracts without full context often need manual review.
  if (/\b(guarantee|guaranteed|penalty|refund|exclusive|legal)\b/.test(lowered)) {
    return true;
  }

  return false;
}

function enforceHumanInterventionTag(args: {
  draft: string;
  latestContext: string;
}): string {
  const trimmed = (args.draft || "").trim();
  if (!trimmed) return trimmed;
  if (/\{HUMAN INTERVENTION NEEDED\}/i.test(trimmed)) return trimmed;
  if (!questionLikelyNeedsHumanIntervention(args.latestContext)) return trimmed;
  return insertLineBeforeSignoff(
    trimmed,
    "{HUMAN INTERVENTION NEEDED} Please review this client question before sending."
  );
}

function latestContextAnswerLines(args: {
  latestContext: string;
  missingFields: string[];
  quoteAlreadyShared: boolean;
  contractReadyToSend: boolean;
}): string[] {
  const signals = analyzeLatestContext(args.latestContext);
  const lines: string[] = [];
  const missingTime = args.missingFields.includes("event_time");

  if (signals.asksInclusions || signals.asksPricing) {
    if (args.quoteAlreadyShared && !args.contractReadyToSend) {
      lines.push(
        "Based on the quote range I already shared, I can finalize a more accurate breakdown once the remaining details are confirmed."
      );
    } else if (missingTime) {
      lines.push(
        "My DJ quote is based on total performance hours and how the events flow, so once your timeline is finalized I can send a precise quote."
      );
    }
  }

  if (signals.asksSetSamples) {
    lines.push("Absolutely, I can send over a sample set that aligns with the genres you shared.");
  }

  if (signals.mentionedExtraServices.length > 0) {
    const serviceList = signals.mentionedExtraServices;
    const readable =
      serviceList.length === 1
        ? serviceList[0]
        : serviceList.length === 2
          ? `${serviceList[0]} and ${serviceList[1]}`
          : `${serviceList.slice(0, -1).join(", ")}, and ${serviceList[serviceList.length - 1]}`;
    lines.push(
      `I personally provide DJ services only, and I can help coordinate ${readable} with trusted vendors (including sound setup/lighting partners) as separately scoped add-ons.`
    );
  }

  if (signals.asksForCall) {
    lines.push("I'd love to set up a call. Share 2-3 time windows that work for you and I'll lock one in.");
  } else if (signals.asksExtraServices) {
    lines.push("Happy to hop on a call and talk through coordination details together.");
  }
  if (signals.asksTravel) {
    lines.push("Absolutely, I can include travel costs in your quote and reflect them in the contract.");
  }

  return lines;
}

function approvedDraftToneExamples(args: {
  store: AdminStore;
  clientId: string;
  max?: number;
}): string[] {
  const max = Math.max(1, Math.min(args.max || 4, 8));
  const approved = args.store.trainingExamples
    .filter((item) => item.decision === "approved" && item.artifactType === "draft_email" && (item.finalOutput || "").trim())
    .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));

  const ordered = [
    ...approved.filter((item) => item.clientId === args.clientId),
    ...approved.filter((item) => item.clientId !== args.clientId),
  ];
  const seen = new Set<string>();
  const examples: string[] = [];
  for (const item of ordered) {
    const text = (item.finalOutput || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    examples.push(text);
    if (examples.length >= max) break;
  }
  return examples;
}

function buildCancellationSupportDraft(args: {
  clientName: string;
  latestContext: string;
}): string {
  const firstName = firstNameFromClient(args.clientName);
  const greeting = firstName ? `Hey ${firstName},` : "Hey there,";
  const text = (args.latestContext || "").toLowerCase();
  const hasGratitude = /\bthank(s| you)?\b|\bappreciate\b/.test(text);
  const hasApology = /\bapolog(?:y|ies|ize|ized|ising)\b|\bsorry\b/.test(text);
  const mentionsAv = /\bav\b|\baudio\s*visual\b/.test(text);

  const lines: string[] = [];
  if (hasApology) {
    lines.push("No worries at all, and thank you for the update.");
  } else {
    lines.push("Thank you for letting me know.");
  }
  if (hasGratitude) {
    lines.push("I really appreciate you considering me and keeping me in the loop.");
  }
  lines.push("I completely support your decision and understand wanting the best fit for logistics and budget.");
  if (mentionsAv) {
    lines.push("Glad I could help on the AV side as well.");
  }
  lines.push("If anything changes or you need support down the line, I’m always happy to help.");

  return `${greeting}\n\n${lines.join(" ")}\n\nBest,\nAnupya`;
}

function draftIsSupportiveForCancellation(value: string): boolean {
  const text = (value || "").toLowerCase();
  if (text.trim() === DRAFT_CANCELLED_NOTICE.toLowerCase()) {
    return true;
  }
  return (
    /(support your decision|understand|no worries|thank you for letting me know|appreciate you considering me)/.test(text) &&
    /(if anything changes|happy to help|always happy to help|reach out anytime)/.test(text)
  );
}

function buildOperationalStageDraft(args: {
  clientName: string;
  rawContext: string;
}): string {
  const firstName = firstNameFromClient(args.clientName);
  const greeting = firstName ? `Hey ${firstName},` : "Hey there,";
  const raw = (args.rawContext || "").toLowerCase();
  const hasTravelPlanning = /\btravel\b|\baccommodation\b|\bhotel\b|\bflight\b|\blogistics\b/.test(raw);
  const hasPlaylistPlanning = /\bplaylist\b|\bset\s*list\b|\bsetlist\b|\bvibe\b|\bmust[-\s]?play\b|\bsong requests?\b|\bmusic direction\b/.test(raw);
  const hasCallPlanning = /\bhop on a call\b|\bschedule (?:a )?call\b|\bphone call\b|\bzoom\b|\bfacetime\b|\bmeet(?:ing)?\b|\bcall\b/.test(raw);
  const hasMultiEventFlow =
    /\bbarat\b|\bceremony\b|\bcocktail\b|\breception\b|\bsangeet\b|\bhaldi\b|\bwelcome dinner\b/.test(raw);

  let body = "";
  if (!hasTravelPlanning) {
    body =
      "As the next step, let’s lock travel/logistics so there are no surprises. Once I have that, I’ll finalize the plan on my side.";
  } else if (!hasPlaylistPlanning) {
    body = hasMultiEventFlow
      ? "Next, I’d love to map playlist direction and vibe for each event segment so the flow feels intentional from start to finish."
      : "Next, I’d love to map playlist direction and overall vibe so the music feels fully tailored to your event.";
  } else if (!hasCallPlanning) {
    body = "If it’s easier, happy to hop on a quick call to align on remaining planning details.";
  } else {
    body = "Everything looks aligned on my side. If you want, we can do a quick planning call to finalize the remaining details.";
  }

  return `${greeting}\n\n${body}\n\nBest,\nAnupya`;
}

function formatHoursForDraft(value?: number): string {
  if (!Number.isFinite(value || NaN) || (value || 0) <= 0) return "TBD";
  const rounded = Math.round((value || 0) * 100) / 100;
  if (Math.abs(rounded - Math.round(rounded)) < 0.0001) {
    return `${Math.round(rounded)} hour${Math.round(rounded) === 1 ? "" : "s"}`;
  }
  return `${rounded} hours`;
}

function formatUsdForDraft(value?: number): string {
  if (!Number.isFinite(value || NaN) || (value || 0) <= 0) return "TBD";
  return `$${Math.round(value || 0).toLocaleString("en-US")}`;
}

function draftQuoteBreakdown(args: {
  extracted: ExtractedInquiry;
  baseRatePerHour: number;
}): {
  perEventBlock: string;
  totalQuote: string;
} {
  const timelineSegments = (args.extracted.timelineSegments || []).filter((segment) => (segment.time || "").trim());
  const sourceRows = timelineSegments.length
    ? timelineSegments.map((segment) => ({
        title: segment.title || args.extracted.eventLabel || args.extracted.eventType || "Event",
        date: segment.date || args.extracted.eventDate || "",
        time: segment.time || "",
      }))
    : [
        {
          title: args.extracted.eventLabel || args.extracted.eventType || "Event",
          date: args.extracted.eventDate || "",
          time: args.extracted.duration || "",
        },
      ];

  const rows = sourceRows.map((row, index) => {
    const dateLabel = formatDateLong({
      timestamp: parseDateToTimestamp(row.date),
      isoDate: row.date,
      fallback: row.date || args.extracted.eventDate || "TBD",
    });
    const dateAndTime = row.time ? `${dateLabel} · ${row.time}` : dateLabel;
    const hours = estimateHoursFromDuration(row.time);
    const amount = deriveAmountFromDuration(row.time, args.baseRatePerHour);

    return {
      title: (row.title || "").trim() || `Event ${index + 1}`,
      dateAndTime,
      billableHours: formatHoursForDraft(hours),
      eventTotal: formatUsdForDraft(amount),
      amount,
    };
  });

  const perEventBlock = rows
    .map(
      (row) =>
        `Event: ${row.title}\nDate: ${row.dateAndTime}\nBillable Hours: ${row.billableHours}\nEvent Total: ${row.eventTotal}`
    )
    .join("\n\n");

  const hasAllAmounts = rows.every((row) => Number.isFinite(row.amount || NaN) && (row.amount || 0) > 0);
  const totalAmount = rows.reduce((sum, row) => sum + (Number.isFinite(row.amount || NaN) ? Number(row.amount || 0) : 0), 0);

  return {
    perEventBlock,
    totalQuote: hasAllAmounts ? formatUsdForDraft(totalAmount) : "TBD",
  };
}

function draftIncludesContractReadyQuoteBreakdown(draft: string): boolean {
  const text = (draft || "").toLowerCase();
  return (
    /event:\s*/i.test(text) &&
    /date:\s*/i.test(text) &&
    /billable hours:\s*/i.test(text) &&
    /event total:\s*/i.test(text) &&
    /total for dj services:\s*/i.test(text)
  );
}

function enforceContractReadyQuoteBreakdown(args: {
  draft: string;
  fallbackDraft: string;
  contractReadyToSend: boolean;
  dateAvailabilityStatus?: DateAvailabilityStatus;
}): string {
  if (!args.contractReadyToSend) return args.draft;
  if (args.dateAvailabilityStatus === "unavailable_other_booking") return args.draft;
  if (draftIncludesContractReadyQuoteBreakdown(args.draft)) return args.draft;
  return args.fallbackDraft;
}

function buildDraftEmail(args: {
  stage: BookingStage;
  status?: EventStatus;
  clientName: string;
  extracted: ExtractedInquiry;
  missingFields: string[];
  dateAvailabilityStatus?: DateAvailabilityStatus;
  availabilityAlreadyShared?: boolean;
  services: string[];
  baseRatePerHour: number;
  hasPriorContext: boolean;
  latestContext: string;
  rawContext?: string;
  preferCheckIn: boolean;
  quoteAlreadyShared: boolean;
  contractReadyToSend: boolean;
}): string {
  if (args.stage === "cancelled") {
    return DRAFT_CANCELLED_NOTICE;
  }
  if (args.status === "cancelled" || clientContextIndicatesCancellation(args.latestContext)) {
    return buildCancellationSupportDraft({
      clientName: args.clientName,
      latestContext: args.latestContext,
    });
  }
  if (args.stage === "in_contract" || args.stage === "execution" || args.stage === "completed") {
    return buildOperationalStageDraft({
      clientName: args.clientName,
      rawContext: args.rawContext || args.latestContext,
    });
  }
  const firstName = firstNameFromClient(args.clientName);
  const greeting = firstName ? `Hey ${firstName},` : "Hey there,";
  if (args.preferCheckIn) {
    return `${greeting}\n\nJust checking in to see if you need anything else from me on this. If it would be easier to discuss live, I’m happy to set up a call anytime.\n\nBest,\nAnupya`;
  }
  const hasCanonicalEventDate = Boolean(
    parseDateToTimestamp(args.extracted.eventDate) || args.extracted.eventDateTimestamp
  );
  const effectiveMissingFields = Array.from(new Set(args.missingFields));
  if (!hasCanonicalEventDate) {
    effectiveMissingFields.push("event_date");
  }
  const followUps = missingFieldQuestions(effectiveMissingFields, args.baseRatePerHour);
  const missingDate = effectiveMissingFields.includes("event_date");
  const missingTime = effectiveMissingFields.includes("event_time");
  const latestSignals = analyzeLatestContext(args.latestContext);
  const noExplicitActionOrQuestion = !latestSignals.hasQuestion && !latestSignals.hasTimelineUpdate;
  if (
    args.hasPriorContext &&
    noExplicitActionOrQuestion &&
    !missingTime &&
    !missingDate &&
    args.dateAvailabilityStatus !== "unavailable_other_booking"
  ) {
    return `${greeting}\n\nThanks for the update. Noted on my end. If it’s easier, happy to hop on a quick call for next steps.\n\nBest,\nAnupya`;
  }
  const answerLines = latestContextAnswerLines({
    latestContext: args.latestContext,
    missingFields: effectiveMissingFields,
    quoteAlreadyShared: args.quoteAlreadyShared,
    contractReadyToSend: args.contractReadyToSend,
  });
  const answerBlock = answerLines.length ? `\n\n${answerLines.join(" ")}` : "";
  const formattedDate = formatDateLong({
    timestamp: parseDateToTimestamp(args.extracted.eventDate) || args.extracted.eventDateTimestamp,
    isoDate: args.extracted.eventDate,
    fallback: args.extracted.eventDate || "That date",
  });
  const availabilityLine =
    args.dateAvailabilityStatus === "unavailable_other_booking"
      ? `I am currently not available on ${formattedDate} because that date is already confirmed on my calendar.`
      : `${formattedDate} is tentatively open for me right now.`;
  const shouldIncludeAvailability =
    hasCanonicalEventDate &&
    !missingDate &&
    (args.dateAvailabilityStatus === "unavailable_other_booking" ||
      (missingTime && !args.availabilityAlreadyShared));
  const availabilityBlock = shouldIncludeAvailability ? `\n\n${availabilityLine}` : "";

  const followUpBlock = followUps.length
    ? `\n\nSo I can send you a more accurate quote, could you confirm:\n${followUps
        .map((line) => `- ${line}`)
        .join("\n")}`
    : "";

  if (args.contractReadyToSend && !effectiveMissingFields.length) {
    if (args.dateAvailabilityStatus === "unavailable_other_booking") {
      return `${greeting}\n\nThank you for reaching out!\n\nI am currently not available on ${formattedDate} because that date is already confirmed on my calendar.\n\nLet me know if you'd like to jump on a call to discuss alternatives.\n\nBest,\nAnupya`;
    }
    const quote = draftQuoteBreakdown({
      extracted: args.extracted,
      baseRatePerHour: args.baseRatePerHour,
    });
    return `${greeting}\n\nThank you for reaching out!\n\nI am available on that date and would love to DJ this event. My quote for this would be as follows:\n\n${quote.perEventBlock}\n\nTotal for DJ services: ${quote.totalQuote}\n\nLet me know if you want to jump on a call to discuss any questions or concerns!\n\nBest,\nAnupya`;
  }

  if (missingTime) {
    const opener = args.hasPriorContext ? "Thanks for the update." : "Thanks for reaching out!";
    const quoteParagraph =
      args.quoteAlreadyShared && !args.contractReadyToSend
        ? "I can dial in the exact quote once I have the complete timeline for each event segment."
        : "I can put together a clear quote once I have the complete timeline for each event segment.";
    return `${greeting}\n\n${opener}${availabilityBlock}\n\n${quoteParagraph}${answerBlock}${followUpBlock}\n\nLet me know if you'd like to hop on a call to discuss :)\n\nBest,\nAnupya`;
  }

  const missing = effectiveMissingFields.length
    ? args.hasPriorContext
      ? `I updated the quote details based on your latest message.${followUpBlock}`
      : `I captured your inquiry details so I can put together an accurate quote.${followUpBlock}`
    : latestSignals.asksPricing || latestSignals.asksInclusions
      ? "I have what I need to finalize your quote based on what you shared."
      : "I can send over a detailed quote based on what you shared.";

  if (args.hasPriorContext) {
    const opener = latestSignals.hasTimelineUpdate ? "Thanks for sharing the timeline details." : "Thanks for the follow-up.";
    return `${greeting}\n\n${opener} ${missing}${answerBlock}${availabilityBlock}\n\nBest,\nAnupya`;
  }

  const naturalOpener = `Thank you for reaching out about your ${args.extracted.eventType || "event"}.`;
  return `${greeting}\n\n${naturalOpener} ${missing}${answerBlock}${availabilityBlock}\n\nBest,\nAnupya`;
}

async function generateProcessedDraftEmail(args: {
  store: AdminStore;
  event: Event;
  client: Client;
  contract?: Contract;
  extracted: ExtractedInquiry;
  sourceContext: string;
  latestContext?: string;
  baseRatePerHour: number;
  contextSummary?: string;
}): Promise<{
  draft: string;
  mode: "heuristic" | "codex" | "codex_fallback";
  model: string;
}> {
  const stageForEmail = detectStage(args.event, args.contract, getInvoiceByEvent(args.store, args.event.id));
  const resolvedLatestContext = args.latestContext || latestInboundContextForDraft(args.sourceContext) || args.sourceContext;
  const dateAvailabilityStatus = classifyDateAvailabilityFromWorkspaces({
    store: args.store,
    targetEventId: args.event.id,
    extracted: args.extracted,
    fallbackEvent: args.event,
  });
  const availabilityAlreadyShared = availabilityAlreadyCommunicated(args.sourceContext);
  const preferCheckIn = shouldGenerateCheckInDraft(args.sourceContext);
  const quoteAlreadyShared = quoteInfoAlreadyShared(args.sourceContext);
  const hasPriorContext = hasPriorConversationContext({
    inquiryCount: args.event.inquiryIds.length,
    rawFeed: args.sourceContext,
  });
  const cancellationDetected =
    clientContextIndicatesCancellation(resolvedLatestContext) || args.event.status === "cancelled";
  const toneExamples = approvedDraftToneExamples({
    store: args.store,
    clientId: args.client.id,
  });
  const emailMissingFields = args.extracted.missingFields;
  const confirmedDetails = buildEmailConfirmedDetails({
    client: args.client,
    event: args.event,
    contract: args.contract,
    extracted: args.extracted,
  });
  const canSendContract = contractReadyToSend({
    contract: args.contract,
    missingFields: emailMissingFields,
  });

  const fallbackDraft = buildDraftEmail({
    stage: stageForEmail,
    status: cancellationDetected ? "cancelled" : args.event.status,
    clientName: args.client.fullName,
    extracted: args.extracted,
    missingFields: emailMissingFields,
    dateAvailabilityStatus,
    availabilityAlreadyShared,
    services: args.event.servicesRequested,
    baseRatePerHour: args.baseRatePerHour,
    hasPriorContext,
    latestContext: resolvedLatestContext,
    rawContext: args.sourceContext,
    preferCheckIn,
    quoteAlreadyShared,
    contractReadyToSend: canSendContract,
  });
  const emailResult = await generateEmailDraftWithCodex({
    stage: stageForEmail,
    status: cancellationDetected ? "cancelled" : args.event.status,
    clientName: args.client.fullName,
    extracted: args.extracted,
    missingFields: emailMissingFields,
    latestContext: resolvedLatestContext,
    fullContext: args.sourceContext,
    contextSummary: args.contextSummary || args.event.latestInquirySummary,
    hasPriorContext,
    preferCheckIn,
    quoteAlreadyShared,
    approvedToneExamples: toneExamples,
    confirmedDetails,
    contractReadyToSend: canSendContract,
    dateAvailabilityStatus,
    availabilityAlreadyShared,
    fallbackDraft,
  });
  let nextDraft = emailResult.draft?.trim() || fallbackDraft;
  if (emailMissingFields.includes("event_time") && !/(timeline|time\s*stamps?|start.{0,20}end)/i.test(nextDraft.toLowerCase())) {
    nextDraft = fallbackDraft;
  }
  if (preferCheckIn && !/(check.?ing in|need anything else|set up a call|hop on a call|happy to set up a call)/i.test(nextDraft.toLowerCase())) {
    nextDraft = fallbackDraft;
  }
  nextDraft = enforceDraftDateConsistency({
    draft: nextDraft,
    fallbackDraft,
    extracted: args.extracted,
  });
  nextDraft = enforceDraftAvailabilityConsistency({
    draft: nextDraft,
    fallbackDraft,
    dateAvailabilityStatus,
    availabilityAlreadyShared,
  });
  nextDraft = enforceContractReadyQuoteBreakdown({
    draft: nextDraft,
    fallbackDraft,
    contractReadyToSend: canSendContract,
    dateAvailabilityStatus,
  });
  nextDraft = enforceHumanInterventionTag({
    draft: nextDraft,
    latestContext: resolvedLatestContext,
  });
  if (cancellationDetected && !draftIsSupportiveForCancellation(nextDraft)) {
    nextDraft = fallbackDraft;
  }

  return {
    draft: nextDraft,
    mode: emailResult.mode,
    model: emailResult.model,
  };
}

async function applyDraftFollowUpWaitState(args: {
  store: AdminStore;
  event: Event;
  client: Client;
  contract?: Contract;
  invoice?: Invoice;
  baseRatePerHour: number;
  nowTs: number;
}): Promise<boolean> {
  const rawFeed = (args.event.latestOcrText || "").trim();
  if (!rawFeed) return false;
  if (!shouldGenerateCheckInDraft(rawFeed)) return false;

  const approvedAtTs = Date.parse(args.event.lastApprovedDraftAt || "");
  if (!Number.isFinite(approvedAtTs)) return false;
  const stage = detectStage(args.event, args.contract, args.invoice);

  if (stage === "cancelled") {
    if (args.event.latestDraftEmail !== DRAFT_CANCELLED_NOTICE) {
      args.event.latestDraftEmail = DRAFT_CANCELLED_NOTICE;
      return true;
    }
    return false;
  }

  if (stage === "in_contract" || stage === "execution" || stage === "completed") {
    const operationsDraft = buildOperationalStageDraft({
      clientName: args.client.fullName,
      rawContext: rawFeed,
    });
    if (args.event.latestDraftEmail !== operationsDraft) {
      args.event.latestDraftEmail = operationsDraft;
      return true;
    }
    return false;
  }

  const elapsed = args.nowTs - approvedAtTs;
  if (elapsed < DRAFT_FOLLOW_UP_WAIT_MS) {
    if (args.event.latestDraftEmail !== DRAFT_FOLLOW_UP_WAIT_NOTICE) {
      args.event.latestDraftEmail = DRAFT_FOLLOW_UP_WAIT_NOTICE;
      return true;
    }
    return false;
  }

  const inquiryPayload = buildInquiryProcessingPayload({ messageText: rawFeed });
  const heuristicExtracted = await coerceExtractedLocationToCity({
    extracted: extractInquiryFromText(inquiryPayload.combinedText, inquiryPayload),
  });
  const extractedForContext = withWorkspaceContextExtracted({
    extracted: heuristicExtracted,
    client: args.client,
    event: args.event,
    contract: args.contract,
  });
  const dateAvailabilityStatus = classifyDateAvailabilityFromWorkspaces({
    store: args.store,
    targetEventId: args.event.id,
    extracted: extractedForContext,
    fallbackEvent: args.event,
  });
  const followUpDraft = buildDraftEmail({
    stage,
    status: args.event.status,
    clientName: args.client.fullName,
    extracted: extractedForContext,
    missingFields: extractedForContext.missingFields,
    dateAvailabilityStatus,
    availabilityAlreadyShared: availabilityAlreadyCommunicated(rawFeed),
    services: args.event.servicesRequested,
    baseRatePerHour: args.baseRatePerHour,
    hasPriorContext: true,
    latestContext: latestInboundContextForDraft(rawFeed) || latestContextFromRawFeed(rawFeed),
    rawContext: rawFeed,
    preferCheckIn: true,
    quoteAlreadyShared: quoteInfoAlreadyShared(rawFeed),
    contractReadyToSend: contractReadyToSend({
      contract: args.contract,
      missingFields: extractedForContext.missingFields,
    }),
  });
  const followUpDraftFinal = enforceHumanInterventionTag({
    draft: followUpDraft,
    latestContext: latestInboundContextForDraft(rawFeed) || latestContextFromRawFeed(rawFeed),
  });
  if (!followUpDraftFinal.trim()) return false;
  if (args.event.latestDraftEmail !== followUpDraftFinal) {
    args.event.latestDraftEmail = followUpDraftFinal;
    return true;
  }
  return false;
}

function buildFallbackAmendmentSuggestion(args: {
  contractText: string;
  inboundMessage: string;
  invoiceAmount: number;
}): string {
  return `${buildAmendmentSuggestion({
    priorContractText: args.contractText,
    inboundMessage: args.inboundMessage,
  })}\n\n${suggestInvoiceUpdates({
    message: args.inboundMessage,
    currentAmount: args.invoiceAmount,
  })}`;
}

function normalizeCurrencyAmount(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseCurrencyCandidates(value: string): number[] {
  const text = (value || "").replace(/[$]/g, " $");
  const pattern = /(?:\b(?:usd|amount|paid|payment|deposit|total|charge)\b[^\d$]{0,12}|\$)\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+(?:\.[0-9]{1,2})?)/gi;
  const amounts: number[] = [];

  for (const match of text.matchAll(pattern)) {
    const raw = (match[1] || "").replace(/,/g, "");
    if (!raw) continue;
    const amount = Number(raw);
    if (!Number.isFinite(amount)) continue;
    if (amount <= 0 || amount > 5_000_000) continue;
    amounts.push(normalizeCurrencyAmount(amount));
  }

  return Array.from(new Set(amounts));
}

function pickClosestAmount(candidates: number[], expectedAmount: number): number | undefined {
  if (!candidates.length) return undefined;
  let best = candidates[0];
  let minDiff = Math.abs(best - expectedAmount);

  for (const candidate of candidates.slice(1)) {
    const diff = Math.abs(candidate - expectedAmount);
    if (diff < minDiff) {
      best = candidate;
      minDiff = diff;
    }
  }

  return best;
}

function expectedChecklistAmount(args: {
  kind: ChecklistProofKind;
  event?: Event;
  contract?: Contract;
  invoice?: Invoice;
}): number | undefined {
  if (args.kind === "deposit_proof") {
    const adjustedDue = args.event?.additionalDepositAmountDue;
    if (
      args.event?.needsAdditionalDepositCollection &&
      typeof adjustedDue === "number" &&
      adjustedDue > 0
    ) {
      return normalizeCurrencyAmount(adjustedDue);
    }
    const amount = args.contract?.dynamicFields.depositAmount;
    if (typeof amount === "number" && amount > 0) return normalizeCurrencyAmount(amount);
    return undefined;
  }

  if (args.kind === "invoice_proof") {
    if (typeof args.invoice?.balanceRemaining === "number" && args.invoice.balanceRemaining > 0) {
      return normalizeCurrencyAmount(args.invoice.balanceRemaining);
    }
    if (typeof args.invoice?.amount === "number" && args.invoice.amount > 0) {
      return normalizeCurrencyAmount(args.invoice.amount);
    }
    const total = args.contract?.dynamicFields.totalAmount;
    if (typeof total === "number" && total > 0) return normalizeCurrencyAmount(total);
  }

  return undefined;
}

function getLatestContract(store: AdminStore, eventId: string): Contract | undefined {
  return store.contracts
    .filter((contract) => contract.eventId === eventId)
    .sort((a, b) => b.version - a.version)[0];
}

function getInvoiceByEvent(store: AdminStore, eventId: string) {
  return store.invoices.find((invoice) => invoice.eventId === eventId);
}

async function persistClientMarkdown(store: AdminStore, clientId: string): Promise<void> {
  const client = store.clients.find((item) => item.id === clientId);
  if (!client) return;
  await updateClientMarkdown({
    client,
    events: store.events.filter((event) => event.clientId === clientId),
    inquiries: store.inquiries.filter((inquiry) => inquiry.clientId === clientId),
    contracts: store.contracts.filter((contract) => contract.clientId === clientId),
    invoices: store.invoices.filter((invoice) => invoice.clientId === clientId),
    documents: store.documents.filter((doc) => doc.clientId === clientId),
    communications: store.communications.filter((entry) => entry.clientId === clientId),
  });
}

async function removePathIfExists(targetPath: string): Promise<void> {
  try {
    await fs.rm(targetPath, { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures so workspace deletion can still succeed.
  }
}

export async function ingestInquiry(args: {
  messageText: string;
  uploadedFile: File | null;
  targetEventId?: string;
  manualContact?: {
    email?: string;
    phone?: string;
    instagramHandle?: string;
  };
}): Promise<{
  eventId: string;
  clientId: string;
  ocrStatus: "not_needed" | "success" | "manual_required";
  ocrReason?: string;
}> {
  const now = nowIso();
  const store = await readStore();
  const baseRate = baseRatePerHour(store);
  const ownerIdentity = adminOwnerIdentity(store);

  const ocr = await runOcrAdapter(args.uploadedFile);
  const forcedEvent = args.targetEventId
    ? store.events.find((item) => item.id === args.targetEventId)
    : undefined;
  if (args.targetEventId && !forcedEvent) {
    throw new Error("Selected workspace was not found.");
  }

  let messageTextForProcessing = args.messageText;
  if (!messageTextForProcessing.trim() && args.uploadedFile && ocr.status === "manual_required") {
    if (forcedEvent) {
      const reason = (ocr.reason || "OCR failed for this image in the current environment.").trim();
      messageTextForProcessing = `[Uploaded File]\nname: ${args.uploadedFile.name}\nchannel: unknown\nocr_status: manual_required\nocr_reason: ${reason}\nmanual_transcription_required: true`;
    } else {
      const reason = ocr.reason ? ` ${ocr.reason}` : "";
      throw new Error(
        `Could not extract context from uploaded file. OCR failed, so workspace creation was blocked. Add text context or upload a clearer screenshot that includes contact details.${reason}`
      );
    }
  }

  const inquiryPayload = buildInquiryProcessingPayload({
    messageText: messageTextForProcessing,
    ocrText: ocr.extractedText,
  });
  const combinedText = inquiryPayload.combinedText;

  const heuristicExtraction = extractInquiryFromText(combinedText, inquiryPayload);
  const codexExtraction = await extractInquiryWithCodex({
    payload: inquiryPayload,
    fallback: heuristicExtraction,
    ownerIdentity,
  });
  const extractedLatest = sanitizeExtractedAgainstOwner({ ...codexExtraction.extracted }, ownerIdentity);
  const manualEmail = (args.manualContact?.email || "").trim().toLowerCase();
  const manualPhone = (args.manualContact?.phone || "").trim();
  const manualInstagram = normalizeInstagramHandle(args.manualContact?.instagramHandle);
  if (manualEmail) {
    extractedLatest.email = manualEmail;
  }
  if (manualPhone) {
    extractedLatest.phone = manualPhone;
  }
  if (manualInstagram) {
    extractedLatest.instagramHandle = manualInstagram;
  }
  const sanitizedExtractedLatest = sanitizeExtractedAgainstOwner(extractedLatest, ownerIdentity);
  extractedLatest.clientName = sanitizedExtractedLatest.clientName;
  extractedLatest.email = sanitizedExtractedLatest.email;
  extractedLatest.phone = sanitizedExtractedLatest.phone;
  extractedLatest.instagramHandle = sanitizedExtractedLatest.instagramHandle;
  if ((extractedLatest.email || extractedLatest.phone || extractedLatest.instagramHandle) && extractedLatest.missingFields.length) {
    extractedLatest.missingFields = extractedLatest.missingFields.filter((field) => field !== "email");
  }
  const hasCreationIdentity = hasWorkspaceCreationIdentity(extractedLatest);

  const heuristicMatch = matchExistingClientAndEvent({
    clients: store.clients,
    events: store.events,
    extracted: extractedLatest,
    rawText: combinedText,
  });
  const strongHeuristicMatch =
    !!heuristicMatch.clientId &&
    (heuristicMatch.reason === "matched_by_email" || (heuristicMatch.confidence || 0) >= 0.9);

  const semanticMatch = strongHeuristicMatch
    ? {
        match: heuristicMatch,
        mode: "heuristic" as const,
        model: "heuristic_only",
      }
    : await semanticMatchWithCodex({
        payload: inquiryPayload,
        rawText: combinedText,
        extracted: extractedLatest,
        clients: store.clients,
        events: store.events,
        fallback: heuristicMatch,
      });

  const match = strongHeuristicMatch ? heuristicMatch : semanticMatch.match;

  let client: Client | undefined = forcedEvent
    ? store.clients.find((item) => item.id === forcedEvent.clientId)
    : match.clientId
      ? store.clients.find((item) => item.id === match.clientId)
      : undefined;

  if (!client) {
    if (!hasCreationIdentity) {
      const extractedDebug = JSON.stringify(
        {
          clientName: extractedLatest.clientName || null,
          email: extractedLatest.email || null,
          phone: extractedLatest.phone || null,
          instagramHandle: extractedLatest.instagramHandle || null,
          eventDate: extractedLatest.eventDate || null,
          location: extractedLatest.location || null,
          servicesRequested: extractedLatest.servicesRequested || [],
          missingFields: extractedLatest.missingFields || [],
        },
        null,
        2
      );
      const ocrDebug = args.uploadedFile
        ? ` OCR status=${ocr.status}${ocr.reason ? `; OCR reason=${ocr.reason}` : ""}${ocr.extractedText ? `; OCR preview=${ocr.extractedText.slice(0, 180).replace(/\s+/g, " ")}` : ""}`
        : "";
      const textScreenshotHint =
        /(?:^|\n)\s*to:\s*[a-z]/i.test(combinedText) || /\bdelivered\b|\bimessage\b|\bmessage\b/i.test(combinedText);
      const routingHint = textScreenshotHint
        ? " For text/iMessage screenshots, either select `Add To Workspace` or provide a phone/email/Instagram contact before processing."
        : "";
      throw new Error(
        `Could not map this context to a workspace. Please either choose an existing workspace, or provide at least one contact method (email/phone/Instagram) so a new workspace can be created.${routingHint} Event time is not required for workspace creation. Extracted payload: ${extractedDebug}.${ocrDebug}`
      );
    }
    client = {
      id: createId("client"),
      fullName: extractedLatest.clientName || "Unknown Client",
      email: extractedLatest.email || `unknown-${createId("mail")}@example.local`,
      phone: extractedLatest.phone,
      instagramHandle: normalizeInstagramHandle(extractedLatest.instagramHandle),
      location: extractedLatest.location,
      secondaryEmails: [],
      createdAt: now,
      updatedAt: now,
    };
    store.clients.push(client);
  } else {
    client.updatedAt = now;
  }
  mergeClientProfileFromExtracted({ client, extracted: extractedLatest });
  sanitizeClientAgainstOwner(client, ownerIdentity);

  let event: Event | undefined = forcedEvent
    ? forcedEvent
    : match.eventId
      ? store.events.find((item) => item.id === match.eventId)
      : undefined;

  const aiSummary = shouldUseCodexForAdmin()
    ? `[extract:${codexSignalLabel(codexExtraction.mode)}:${codexExtraction.model}] [match:${codexSignalLabel(semanticMatch.mode)}:${semanticMatch.model}] ${codexDebugSummary({ extracted: extractedLatest, match })}`
    : "";

  if (!event) {
    event = {
      id: createId("event"),
      clientId: client.id,
      eventType: extractedLatest.eventType,
      eventDate: extractedLatest.eventDate,
      eventDateTimestamp: extractedLatest.eventDateTimestamp,
      venue: isSafeLocationValue(extractedLatest.location) ? extractedLatest.location : undefined,
      servicesRequested: extractedLatest.servicesRequested,
      guestCount: extractedLatest.guestCount,
      duration:
        extractedLatest.duration ||
        (extractedLatest.timelineSegments || [])
          .map((item) => item.time)
          .filter(Boolean)
          .join("; "),
      status: "inquiry_received",
      depositStatus: "none",
      signedContract: false,
      initialDepositReceived: false,
      stage: "inquiry",
      inquiryIds: [],
      communicationIds: [],
      documentIds: [],
      latestDraftEmail: "",
      latestOcrText: "",
      latestInquirySummary: "",
      latestNotes: aiSummary,
      needsAdjustedContractSignature: false,
      adjustedContractSigned: false,
      needsAdditionalDepositCollection: false,
      additionalDepositCollected: false,
      workspaceDateBoundsLocked: false,
      manualDocumentsCount: 0,
      profile: defaultWorkspaceProfile({
        client,
        extracted: extractedLatest,
      }),
      createdAt: now,
      updatedAt: now,
    };
    store.events.push(event);
  } else {
    event.updatedAt = now;
    event.eventType = extractedLatest.eventType || event.eventType;
    event.eventDate = extractedLatest.eventDate || event.eventDate;
    event.eventDateTimestamp = extractedLatest.eventDateTimestamp || event.eventDateTimestamp;
    event.venue = isSafeLocationValue(extractedLatest.location) ? extractedLatest.location : event.venue;
    event.guestCount = extractedLatest.guestCount || event.guestCount;
    event.duration =
      extractedLatest.duration ||
      (extractedLatest.timelineSegments || [])
        .map((item) => item.time)
        .filter(Boolean)
        .join("; ") ||
      event.duration;
    event.servicesRequested = Array.from(new Set([...event.servicesRequested, ...extractedLatest.servicesRequested]));
    if (typeof event.signedContract !== "boolean") {
      event.signedContract = false;
    }
    if (typeof event.initialDepositReceived !== "boolean") {
      event.initialDepositReceived = event.depositStatus === "received";
    }
    if (typeof event.needsAdjustedContractSignature !== "boolean") {
      event.needsAdjustedContractSignature = false;
    }
    if (typeof event.adjustedContractSigned !== "boolean") {
      event.adjustedContractSigned = false;
    }
    if (typeof event.needsAdditionalDepositCollection !== "boolean") {
      event.needsAdditionalDepositCollection = false;
    }
    if (typeof event.additionalDepositCollected !== "boolean") {
      event.additionalDepositCollected = false;
    }
    if (typeof event.workspaceDateBoundsLocked !== "boolean") {
      event.workspaceDateBoundsLocked = false;
    }
    if (aiSummary) {
      event.latestNotes = aiSummary;
    }
  }
  const rawFeedForDateWindow = event.latestOcrText
    ? appendRawInquiryFeed(event.latestOcrText, combinedText)
    : combinedText;
  applyExtractedDateWindow(event, extractedLatest, {
    rawText: rawFeedForDateWindow,
  });

  const formattedInboundContext = await buildInboundContextBlock({
    rawText: combinedText,
    hasUpload: Boolean(args.uploadedFile),
    clientName: extractedLatest.clientName || client.fullName,
    ownerIdentity,
  });
  if (!event.latestOcrText) {
    event.latestOcrText = formattedInboundContext || combinedText;
  } else {
    event.latestOcrText = appendRawInquiryFeed(event.latestOcrText, formattedInboundContext || combinedText);
  }

  let uploadedDocumentIds: string[] = [];
  if (args.uploadedFile) {
    const saved = await saveUploadedFile({ file: args.uploadedFile, clientId: client.id });
    const docId = createId("doc");
    store.documents.push({
      id: docId,
      clientId: client.id,
      eventId: event.id,
      filename: args.uploadedFile.name,
      storedPath: saved.relativePath,
      mimeType: saved.mimeType,
      sizeBytes: saved.sizeBytes,
      uploadedAt: now,
    });
    event.documentIds.push(docId);
    uploadedDocumentIds = [docId];
  }

  const inquiry: Inquiry = {
    id: createId("inquiry"),
    clientId: client.id,
    eventId: event.id,
    rawText: args.messageText,
    extractedText: combinedText,
    source:
      args.messageText && args.uploadedFile
        ? "mixed"
        : args.uploadedFile
          ? "upload"
          : "paste",
    uploadedDocumentIds,
    missingFields: extractedLatest.missingFields,
    createdAt: now,
  };
  store.inquiries.push(inquiry);
  event.inquiryIds.push(inquiry.id);

  const inboundCommunication: Communication = {
    id: createId("comm"),
    clientId: client.id,
    eventId: event.id,
    kind: "inbound",
    content: combinedText,
    createdAt: now,
  };
  store.communications.push(inboundCommunication);
  event.communicationIds.push(inboundCommunication.id);

  const currentContract = getLatestContract(store, event.id);
  const currentInvoice = getInvoiceByEvent(store, event.id);
  applyCancellationSignal(event, combinedText);
  event.stage = detectStage(event, currentContract, currentInvoice);

  if (!event.latestOcrText && combinedText) {
    event.latestOcrText = combinedText;
  }

  const fullContextPayload = buildInquiryProcessingPayload({
    messageText: event.latestOcrText || combinedText,
  });
  const fullHeuristicExtraction = extractInquiryFromText(fullContextPayload.combinedText, fullContextPayload);
  const fullCodexExtraction = await extractInquiryWithCodex({
    payload: fullContextPayload,
    fallback: fullHeuristicExtraction,
    ownerIdentity,
  });
  const extractedForContract = withWorkspaceContextExtracted({
    extracted: sanitizeExtractedAgainstOwner(fullCodexExtraction.extracted, ownerIdentity),
    client,
    event,
    contract: currentContract,
  });

  mergeClientProfileFromExtracted({ client, extracted: extractedForContract });
  sanitizeClientAgainstOwner(client, ownerIdentity);
  event.eventType = extractedForContract.eventType || event.eventType;
  event.eventDate = extractedForContract.eventDate || event.eventDate;
  event.eventDateTimestamp = extractedForContract.eventDateTimestamp || event.eventDateTimestamp;
  applyExtractedDateWindow(event, extractedForContract, {
    rawText: event.latestOcrText || combinedText,
  });
  mergeEventProfileFromExtracted({ event, extracted: extractedForContract });
  await refreshWorkspaceProfileFromContext({
    event,
    client,
    extracted: extractedForContract,
    rawText: event.latestOcrText || combinedText,
    ownerIdentity,
  });

  const fallbackSummary = buildFallbackInquirySummary({
    extracted: extractedForContract,
    stage: event.stage,
    rawText: event.latestOcrText || combinedText,
  });
  const summaryResult = await summarizeInquiryWithCodex({
    rawText: event.latestOcrText || combinedText,
    extracted: extractedForContract,
    stage: event.stage,
    fallbackSummary,
  });
  event.latestInquirySummary = summaryResult.summary;
  if (shouldUseCodexForAdmin()) {
    event.latestNotes = `${event.latestNotes ? `${event.latestNotes} ` : ""}[summary:${codexSignalLabel(summaryResult.mode)}:${summaryResult.model}]`;
  }

  const fullRawContext = (event.latestOcrText || combinedText || "").trim();
  const latestContext = latestInboundContextForDraft(fullRawContext) || combinedText;

  let contract = currentContract;
  if (!contract) {
    const initialFields = refreshDynamicFieldsFromExtraction(undefined, extractedForContract, baseRate);
    const pricedFields = applyPricingDirectiveFromRawContext(initialFields, event.latestOcrText);
    const boundedFields = applyWorkspaceBoundsToContractFields(pricedFields, event);
    const rendered = renderContract(boundedFields, CONTRACT_LEGAL_BODY, client.fullName);
    contract = {
      id: createId("contract"),
      eventId: event.id,
      clientId: client.id,
      version: 1,
      status: "draft",
      dynamicFields: rendered.normalizedFields,
      legalBody: CONTRACT_LEGAL_BODY,
      renderedText: rendered.renderedText,
      createdAt: now,
      updatedAt: now,
    };
    store.contracts.push(contract);
    event.contractId = contract.id;
    event.status = "contract_drafted";
    await saveGeneratedContract({ eventId: event.id, version: 1, text: rendered.renderedText });
  } else {
    const refreshedFields = refreshDynamicFieldsFromExtraction(contract.dynamicFields, extractedForContract, baseRate);
    const pricedFields = applyPricingDirectiveFromRawContext(refreshedFields, event.latestOcrText);
    const boundedFields = applyWorkspaceBoundsToContractFields(pricedFields, event);
    const rendered = renderContract(boundedFields, contract.legalBody || CONTRACT_LEGAL_BODY, client.fullName);
    if (contract.status === "approved") {
      const newVersion = contract.version + 1;
      const nextDraft: Contract = {
        id: createId("contract"),
        eventId: event.id,
        clientId: client.id,
        version: newVersion,
        status: "draft",
        dynamicFields: rendered.normalizedFields,
        legalBody: contract.legalBody || CONTRACT_LEGAL_BODY,
        renderedText: rendered.renderedText,
        createdAt: now,
        updatedAt: now,
      };
      store.contracts.push(nextDraft);
      contract = nextDraft;
      event.contractId = nextDraft.id;
    } else {
      contract.dynamicFields = rendered.normalizedFields;
      contract.renderedText = rendered.renderedText;
      contract.updatedAt = now;
    }
    await saveGeneratedContract({ eventId: event.id, version: contract.version, text: contract.renderedText });
  }

  recomputeWorkspaceDateRange(event, contract, { force: true });
  applyTemporalWorkspaceStatus(event, { contract, invoice: currentInvoice });

  const invoice = invoiceFromContract({
    invoice: currentInvoice,
    eventId: event.id,
    clientId: client.id,
    fields: contract.dynamicFields,
    services: event.servicesRequested,
    nowIso: now,
  });

  if (currentInvoice) {
    const index = store.invoices.findIndex((item) => item.id === currentInvoice.id);
    store.invoices[index] = invoice;
  } else {
    store.invoices.push(invoice);
  }
  event.invoiceId = invoice.id;
  applyTemporalWorkspaceStatus(event, { contract, invoice });

  const extractedForEmail = withWorkspaceContextExtracted({
    extracted: extractedForContract,
    client,
    event,
    contract,
  });
  const draftResult = await generateProcessedDraftEmail({
    store,
    event,
    client,
    contract,
    extracted: extractedForEmail,
    sourceContext: fullRawContext,
    latestContext,
    baseRatePerHour: baseRate,
    contextSummary: event.latestInquirySummary,
  });
  event.latestDraftEmail = draftResult.draft;
  store.communications.push({
    id: createId("comm"),
    clientId: client.id,
    eventId: event.id,
    kind: "draft_email",
    content: draftResult.draft,
    createdAt: now,
  });
  event.communicationIds.push(store.communications[store.communications.length - 1].id);
  if (shouldUseCodexForAdmin()) {
    event.latestNotes = `${event.latestNotes ? `${event.latestNotes} ` : ""}[extract_full:${codexSignalLabel(fullCodexExtraction.mode)}:${fullCodexExtraction.model}] [email:${codexSignalLabel(draftResult.mode)}:${draftResult.model}]`;
  }

  if (event.stage === "execution") {
    const fallbackAmendment = buildFallbackAmendmentSuggestion({
      contractText: contract.renderedText,
      inboundMessage: combinedText,
      invoiceAmount: invoice.amount,
    });
    const amendmentResult = await suggestAmendmentWithCodex({
      inboundMessage: combinedText,
      contractText: contract.renderedText,
      invoiceHint: `total=${invoice.amount} deposit=${invoice.depositAmount} remaining=${invoice.balanceRemaining} due=${invoice.paymentDueDate || ""}`,
      fallbackSuggestion: fallbackAmendment,
    });
    event.amendmentSuggestion = amendmentResult.suggestion;
    if (shouldUseCodexForAdmin()) {
      event.latestNotes = `${event.latestNotes ? `${event.latestNotes} ` : ""}[amendment:${codexSignalLabel(amendmentResult.mode)}:${amendmentResult.model}]`;
    }
  } else {
    event.amendmentSuggestion = undefined;
  }

  event.stage = detectStage(event, contract, invoice);
  await applyDraftFollowUpWaitState({
    store,
    event,
    client,
    contract,
    invoice,
    baseRatePerHour: baseRate,
    nowTs: Date.now(),
  });
  event.updatedAt = now;

  await writeStore(store);
  await persistClientMarkdown(store, client.id);

  return {
    eventId: event.id,
    clientId: client.id,
    ocrStatus: ocr.status,
    ocrReason: ocr.reason,
  };
}

export async function getWorkspaceByEventId(eventId: string): Promise<WorkspaceSnapshot | null> {
  const store = await readStore();
  const ownerIdentity = adminOwnerIdentity(store);
  const event = store.events.find((item) => item.id === eventId);
  if (!event) {
    return null;
  }
  const client = store.clients.find((item) => item.id === event.clientId);
  if (!client) {
    return null;
  }
  let shouldPersist = false;
  const originalClient = JSON.stringify(client);
  sanitizeClientAgainstOwner(client, ownerIdentity);
  if (JSON.stringify(client) !== originalClient) {
    shouldPersist = true;
  }

  if (typeof event.needsAdjustedContractSignature !== "boolean") {
    event.needsAdjustedContractSignature = false;
  }
  if (typeof event.adjustedContractSigned !== "boolean") {
    event.adjustedContractSigned = false;
  }
  if (typeof event.needsAdditionalDepositCollection !== "boolean") {
    event.needsAdditionalDepositCollection = false;
  }
  if (typeof event.additionalDepositCollected !== "boolean") {
    event.additionalDepositCollected = false;
  }
  const normalizedProfile = event.profile
    ? sanitizeWorkspaceProfileAgainstOwner(event.profile, ownerIdentity)
    : sanitizeWorkspaceProfileAgainstOwner(
        defaultWorkspaceProfile({
          existing: event.profile,
          client,
          event,
        }),
        ownerIdentity
      );
  if (JSON.stringify(event.profile || {}) !== JSON.stringify(normalizedProfile)) {
    event.profile = normalizedProfile;
    shouldPersist = true;
  }
  const eventDocumentCount = store.documents.filter((doc) => doc.eventId === event.id).length;
  if (typeof event.manualDocumentsCount !== "number") {
    event.manualDocumentsCount = eventDocumentCount;
    shouldPersist = true;
  }

  const contract = getLatestContract(store, event.id);
  const invoice = getInvoiceByEvent(store, event.id);
  const originalStatus = event.status;
  const originalStart = event.workspaceStartTimestamp;
  const originalEnd = event.workspaceEndTimestamp;
  recomputeWorkspaceDateRange(event, contract);
  syncEventDateFromWorkspaceBounds(event);
  applyTemporalWorkspaceStatus(event, { contract, invoice });
  event.stage = detectStage(event, contract, invoice);
  if (
    await applyDraftFollowUpWaitState({
      store,
      event,
      client,
      contract,
      invoice,
      baseRatePerHour: baseRatePerHour(store),
      nowTs: Date.now(),
    })
  ) {
    shouldPersist = true;
  }

  const latestInquiry = store.inquiries
    .filter((inquiry) => inquiry.eventId === event.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const rawFeed = (event.latestOcrText || latestInquiry?.extractedText || "").trim();

  if (rawFeed && !event.latestOcrText) {
    event.latestOcrText = rawFeed;
    shouldPersist = true;
  }

  if (rawFeed && !event.latestInquirySummary?.trim()) {
    const inquiryPayload = buildInquiryProcessingPayload({ messageText: rawFeed });
    const heuristicExtracted = await coerceExtractedLocationToCity({
      extracted: extractInquiryFromText(inquiryPayload.combinedText, inquiryPayload),
    });
    const extracted = withWorkspaceContextExtracted({
      extracted: heuristicExtracted,
      client,
      event,
      contract,
    });
    const fallbackSummary = buildFallbackInquirySummary({
      extracted,
      stage: event.stage,
      rawText: rawFeed,
    });
    const summaryResult = await summarizeInquiryWithCodex({
      rawText: rawFeed,
      extracted,
      stage: event.stage,
      fallbackSummary,
    });
    event.latestInquirySummary = summaryResult.summary;
    shouldPersist = true;
  }

  if (
    event.status !== originalStatus ||
    event.workspaceStartTimestamp !== originalStart ||
    event.workspaceEndTimestamp !== originalEnd
  ) {
    shouldPersist = true;
  }

  if (shouldPersist) {
    event.updatedAt = nowIso();
    await writeStore(store);
  }

  return {
    client,
    event,
    inquiries: store.inquiries.filter((inquiry) => inquiry.eventId === event.id),
    contract,
    invoice,
    documents: store.documents.filter((doc) => doc.eventId === event.id),
    communications: store.communications.filter((entry) => entry.eventId === event.id),
  };
}

export async function listProfiles(): Promise<Array<{
  clientId: string;
  fullName: string;
  email: string;
  latestEventId?: string;
  stage: BookingStage;
  eventDate?: string;
  eventDateTimestamp?: number;
  venue?: string;
  documents: number;
}>> {
  const store = await readStore();
  const ownerIdentity = adminOwnerIdentity(store);

  return store.clients.map((client) => {
    const visibleClient: Client = structuredClone(client);
    sanitizeClientAgainstOwner(visibleClient, ownerIdentity);
    const events = store.events
      .filter((event) => event.clientId === client.id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const latestEvent = events[0];

    if (!latestEvent) {
      return {
        clientId: client.id,
        fullName: visibleClient.fullName,
        email: visibleClient.email,
        stage: "inquiry" as const,
        documents: 0,
      };
    }

    const contract = getLatestContract(store, latestEvent.id);
    const invoice = getInvoiceByEvent(store, latestEvent.id);
    recomputeWorkspaceDateRange(latestEvent, contract);
    syncEventDateFromWorkspaceBounds(latestEvent);
    applyTemporalWorkspaceStatus(latestEvent, { contract, invoice });
    const stage = detectStage(latestEvent, contract, invoice);

    return {
      clientId: client.id,
      fullName: visibleClient.fullName,
      email: visibleClient.email,
      latestEventId: latestEvent.id,
      stage,
      eventDate: latestEvent.eventDate,
      eventDateTimestamp: latestEvent.eventDateTimestamp,
      venue: latestEvent.venue,
      documents: store.documents.filter((doc) => doc.clientId === client.id).length,
    };
  });
}

export async function listWorkspaces(): Promise<WorkspaceListItem[]> {
  const store = await readStore();
  const ownerIdentity = adminOwnerIdentity(store);

  return store.events
    .map((event) => {
      const client = store.clients.find((item) => item.id === event.clientId);
      if (!client) {
        return null;
      }
      const visibleClient: Client = structuredClone(client);
      sanitizeClientAgainstOwner(visibleClient, ownerIdentity);
      const contract = getLatestContract(store, event.id);
      const invoice = getInvoiceByEvent(store, event.id);
      recomputeWorkspaceDateRange(event, contract);
      syncEventDateFromWorkspaceBounds(event);
      applyTemporalWorkspaceStatus(event, { contract, invoice });
      const stage = detectStage(event, contract, invoice);

      return {
        eventId: event.id,
        clientId: visibleClient.id,
        clientName: visibleClient.fullName,
        clientEmail: visibleClient.email,
        clientPhone: visibleClient.phone,
        clientInstagramHandle: visibleClient.instagramHandle,
        primaryContact: primaryClientContact(visibleClient),
        workspaceTitle: workspaceTitleLabel({
          clientName: visibleClient.fullName,
          eventType: event.eventType,
          eventDate: event.eventDate,
          eventDateTimestamp: event.eventDateTimestamp,
          workspaceStartTimestamp: event.workspaceStartTimestamp,
        }),
        latestContextSummary: latestContextSummaryForList(event.latestOcrText || ""),
        stage,
        status: event.status,
        signedContract: signedContractState(event, contract),
        initialDepositReceived: depositSentState(event, invoice),
        invoiceStatus: invoice?.status,
        eventType: event.eventType,
        eventDate: event.eventDate,
        eventDateTimestamp: event.eventDateTimestamp,
        workspaceStartTimestamp: event.workspaceStartTimestamp,
        workspaceEndTimestamp: event.workspaceEndTimestamp,
        venue: event.venue,
        contractTotalAmount: contract?.dynamicFields.totalAmount || 0,
        lastModifiedAt: event.updatedAt,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((a, b) => b.lastModifiedAt.localeCompare(a.lastModifiedAt));
}

export async function getProfileByClientId(clientId: string): Promise<{
  client: Client;
  events: Event[];
  contracts: Contract[];
  invoices: AdminStore["invoices"];
  documents: AdminStore["documents"];
  communications: AdminStore["communications"];
} | null> {
  const store = await readStore();
  const ownerIdentity = adminOwnerIdentity(store);
  const client = store.clients.find((item) => item.id === clientId);
  if (!client) {
    return null;
  }
  const visibleClient: Client = structuredClone(client);
  sanitizeClientAgainstOwner(visibleClient, ownerIdentity);

  const events = store.events
    .filter((event) => event.clientId === client.id)
    .map((event) => {
      const contract = getLatestContract(store, event.id);
      const invoice = getInvoiceByEvent(store, event.id);
      recomputeWorkspaceDateRange(event, contract);
      applyTemporalWorkspaceStatus(event, { contract, invoice });
      return {
        ...event,
        stage: detectStage(event, contract, invoice),
      };
    });

  return {
    client: visibleClient,
    events,
    contracts: store.contracts.filter((contract) => contract.clientId === client.id),
    invoices: store.invoices.filter((invoice) => invoice.clientId === client.id),
    documents: store.documents.filter((document) => document.clientId === client.id),
    communications: store.communications.filter((entry) => entry.clientId === client.id),
  };
}

export async function deleteWorkspace(eventId: string): Promise<boolean> {
  const store = await readStore();
  const event = store.events.find((item) => item.id === eventId);
  if (!event) {
    return false;
  }

  const clientId = event.clientId;
  const docsToDelete = store.documents.filter((document) => document.eventId === eventId);

  store.events = store.events.filter((item) => item.id !== eventId);
  store.inquiries = store.inquiries.filter((item) => item.eventId !== eventId);
  store.contracts = store.contracts.filter((item) => item.eventId !== eventId);
  store.invoices = store.invoices.filter((item) => item.eventId !== eventId);
  store.documents = store.documents.filter((item) => item.eventId !== eventId);
  store.communications = store.communications.filter((item) => item.eventId !== eventId);
  store.trainingExamples = store.trainingExamples.filter((item) => item.eventId !== eventId);

  const clientStillReferenced =
    store.events.some((item) => item.clientId === clientId) ||
    store.inquiries.some((item) => item.clientId === clientId) ||
    store.contracts.some((item) => item.clientId === clientId) ||
    store.invoices.some((item) => item.clientId === clientId) ||
    store.documents.some((item) => item.clientId === clientId) ||
    store.communications.some((item) => item.clientId === clientId);

  if (!clientStillReferenced) {
    store.clients = store.clients.filter((item) => item.id !== clientId);
  }

  await writeStore(store);

  await Promise.all(
    docsToDelete.map((document) => {
      const absolutePath = path.isAbsolute(document.storedPath)
        ? document.storedPath
        : path.resolve(process.cwd(), document.storedPath);
      return removePathIfExists(absolutePath);
    })
  );

  await removePathIfExists(path.join(getContractsDir(), "generated", eventId));

  if (clientStillReferenced) {
    await persistClientMarkdown(store, clientId);
  } else {
    await removePathIfExists(path.join(getClientsDir(), `client_${clientId}.md`));
    await removePathIfExists(path.join(getUploadsDir(), clientId));
  }

  return true;
}

export async function uploadWorkspaceChecklistProof(args: {
  eventId: string;
  kind: ChecklistProofKind;
  file: File;
}): Promise<ChecklistProofUploadResult | null> {
  const now = nowIso();
  const store = await readStore();
  const event = store.events.find((item) => item.id === args.eventId);
  if (!event) {
    return null;
  }

  const client = store.clients.find((item) => item.id === event.clientId);
  if (!client) {
    return null;
  }

  const contract = getLatestContract(store, event.id);
  const invoice = getInvoiceByEvent(store, event.id);
  const expectedAmount = expectedChecklistAmount({ kind: args.kind, event, contract, invoice });

  const displayPrefix =
    args.kind === "signed_contract"
      ? "signed_contract"
      : args.kind === "deposit_proof"
        ? "deposit_proof"
        : "invoice_proof";

  let extractedAmount: number | undefined;
  let amountMatched = args.kind === "signed_contract";
  let ocrStatus: "not_needed" | "success" | "manual_required" = "not_needed";
  let ocrReason: string | undefined;
  let validationMessage = "Signed contract uploaded.";

  if (args.kind !== "signed_contract") {
    const ocr = await runOcrAdapter(args.file);
    ocrStatus = ocr.status;
    ocrReason = ocr.reason;

    if (typeof expectedAmount !== "number" || expectedAmount <= 0) {
      amountMatched = false;
      validationMessage =
        args.kind === "deposit_proof"
          ? "Deposit amount is unavailable from the contract. Confirm deposit fields first."
          : "Invoice amount is unavailable. Confirm invoice fields first.";
    } else if (ocr.status !== "success" || !ocr.extractedText.trim()) {
      amountMatched = false;
      validationMessage =
        args.kind === "deposit_proof"
          ? "Unable to OCR the deposit screenshot. Upload a clearer screenshot or a .txt export."
          : "Unable to OCR the invoice screenshot. Upload a clearer screenshot or a .txt export.";
    } else {
      const candidates = parseCurrencyCandidates(ocr.extractedText);
      const selected = pickClosestAmount(candidates, expectedAmount);
      if (typeof selected === "number") {
        extractedAmount = normalizeCurrencyAmount(selected);
      }
      amountMatched =
        typeof extractedAmount === "number" &&
        Math.abs(extractedAmount - expectedAmount) <= PAYMENT_MATCH_TOLERANCE;
      validationMessage = amountMatched
        ? `OCR matched payment amount (${extractedAmount}) to expected amount (${expectedAmount}).`
        : `OCR amount mismatch. Expected ${expectedAmount}, extracted ${extractedAmount ?? "none"}.`;
    }
  }

  if (!amountMatched) {
    return {
      kind: args.kind,
      expectedAmount,
      extractedAmount,
      amountMatched,
      ocrStatus,
      ocrReason,
      validationMessage,
    };
  }

  const saved = await saveUploadedFile({ file: args.file, clientId: client.id });
  const docId = createId("doc");
  store.documents.push({
    id: docId,
    clientId: client.id,
    eventId: event.id,
    filename: `${displayPrefix}_${args.file.name}`,
    storedPath: saved.relativePath,
    mimeType: saved.mimeType,
    sizeBytes: saved.sizeBytes,
    uploadedAt: now,
  });

  if (!event.documentIds.includes(docId)) {
    event.documentIds.push(docId);
  }

  event.updatedAt = now;
  await writeStore(store);
  await persistClientMarkdown(store, client.id);

  return {
    kind: args.kind,
    document: {
      id: docId,
      filename: `${displayPrefix}_${args.file.name}`,
      mimeType: saved.mimeType,
      uploadedAt: now,
    },
    expectedAmount,
    extractedAmount,
    amountMatched,
    ocrStatus,
    ocrReason,
    validationMessage,
  };
}

export async function updateWorkspace(args: {
  eventId: string;
  emailDraft?: string;
  regenerateDraftEmail?: boolean;
  approveDraftEmail?: boolean;
  notes?: string;
  ocrText?: string;
  reanalyzeFromRaw?: boolean;
  signedContract?: boolean;
  initialDepositReceived?: boolean;
  fullInvoicePaid?: boolean;
  adjustedContractSigned?: boolean;
  additionalDepositCollected?: boolean;
  workspaceMeta?: {
    workspaceStartTimestamp?: number | null;
    workspaceEndTimestamp?: number | null;
    stage?: BookingStage;
    status?: Event["status"];
    venue?: string;
    documentsCount?: number | null;
    contractTotalAmount?: number | null;
  };
  profile?: WorkspaceProfile;
  contractFields?: ContractDynamicFields;
  approveContractFields?: boolean;
  approveContract?: boolean;
  markDepositReceived?: boolean;
  addToMemory?: boolean;
  memoryDecision?: "approved" | "edited" | "rejected";
  memoryFinalOutput?: string;
  memoryChangeSummary?: string;
}): Promise<WorkspaceSnapshot | null> {
  const now = nowIso();
  const store = await readStore();
  const baseRate = baseRatePerHour(store);
  const ownerIdentity = adminOwnerIdentity(store);
  const event = store.events.find((item) => item.id === args.eventId);
  if (!event) {
    return null;
  }

  const client = store.clients.find((item) => item.id === event.clientId);
  if (!client) {
    return null;
  }
  sanitizeClientAgainstOwner(client, ownerIdentity);
  event.profile = event.profile
    ? sanitizeWorkspaceProfileAgainstOwner(event.profile, ownerIdentity)
    : sanitizeWorkspaceProfileAgainstOwner(
        defaultWorkspaceProfile({
          existing: event.profile,
          client,
          event,
        }),
        ownerIdentity
      );
  client.updatedAt = now;

  let contract = getLatestContract(store, event.id);
  let summaryUpdatedThisRequest = false;

  const latestInquiry = store.inquiries
    .filter((inquiry) => inquiry.eventId === event.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  if (typeof args.emailDraft === "string") {
    event.latestDraftEmail = args.emailDraft;
    store.communications.push({
      id: createId("comm"),
      clientId: client.id,
      eventId: event.id,
      kind: "draft_email",
      content: args.emailDraft,
      createdAt: now,
    });
  }

  if (args.approveDraftEmail) {
    const approvedDraft = (event.latestDraftEmail || "").trim();
    if (approvedDraft) {
      event.lastApprovedDraftAt = now;
      event.latestOcrText = appendWorkspaceContext(
        event.latestOcrText,
        buildApprovedContextBlock({
          artifactType: "draft_email",
          content: approvedDraft,
        })
      );
      addApprovedTrainingExample({
        store,
        clientId: client.id,
        event,
        latestInquiry,
        generatedOutput: approvedDraft,
        finalOutput: approvedDraft,
        artifactType: "draft_email",
        now,
      });

      applyCancellationSignal(event, approvedDraft);
      const hasPerEventPricingOverride = parseEventPriceOverridesFromText(approvedDraft).length > 0;
      let extractedFromApprovedDraft: ExtractedInquiry | undefined;
      const rawFeedForDraftApproval = (event.latestOcrText || "").trim();
      if (rawFeedForDraftApproval) {
        const inquiryPayload = buildInquiryProcessingPayload({
          messageText: rawFeedForDraftApproval,
        });
        const heuristicExtraction = extractInquiryFromText(inquiryPayload.combinedText, inquiryPayload);
        const extractionResult = await extractInquiryWithCodex({
          payload: inquiryPayload,
          fallback: heuristicExtraction,
          ownerIdentity,
        });
        extractedFromApprovedDraft = withWorkspaceContextExtracted({
          extracted: sanitizeExtractedAgainstOwner(extractionResult.extracted, ownerIdentity),
          client,
          event,
          contract,
        });

        mergeClientProfileFromExtracted({ client, extracted: extractedFromApprovedDraft });
        sanitizeClientAgainstOwner(client, ownerIdentity);
        mergeEventProfileFromExtracted({ event, extracted: extractedFromApprovedDraft });
        applyExtractedDateWindow(event, extractedFromApprovedDraft, {
          rawText: rawFeedForDraftApproval,
        });
        await refreshWorkspaceProfileFromContext({
          event,
          client,
          extracted: extractedFromApprovedDraft,
          rawText: rawFeedForDraftApproval,
          ownerIdentity,
        });

        const stageForSummary = detectStage(event, contract, getInvoiceByEvent(store, event.id));
        const fallbackSummary = buildFallbackInquirySummary({
          extracted: extractedFromApprovedDraft,
          stage: stageForSummary,
          rawText: rawFeedForDraftApproval,
        });
        const summaryResult = await summarizeInquiryWithCodex({
          rawText: rawFeedForDraftApproval,
          extracted: extractedFromApprovedDraft,
          stage: stageForSummary,
          fallbackSummary,
        });
        event.latestInquirySummary = summaryResult.summary;
        summaryUpdatedThisRequest = true;
      }

      if (contract || extractedFromApprovedDraft) {
        const baseFields = contract?.dynamicFields || defaultDynamicFields(extractedFromApprovedDraft!, baseRate);
        const refreshedFromDraft = extractedFromApprovedDraft && !hasPerEventPricingOverride
          ? refreshDynamicFieldsFromExtraction(baseFields, extractedFromApprovedDraft, baseRate)
          : baseFields;
        const shouldVersion = event.stage === "execution" || contract?.status === "approved";
        const pricedFromDraft = applyPricingDirectiveFromRawContext(refreshedFromDraft, event.latestOcrText);
        const boundedFromDraft = applyWorkspaceBoundsToContractFields(pricedFromDraft, event);
        const rendered = renderContract(boundedFromDraft, contract?.legalBody || CONTRACT_LEGAL_BODY, client.fullName);
        if (!contract || shouldVersion) {
          const nextDraft: Contract = {
            id: createId("contract"),
            eventId: event.id,
            clientId: client.id,
            version: (contract?.version || 0) + 1,
            status: "draft",
            dynamicFields: rendered.normalizedFields,
            legalBody: contract?.legalBody || CONTRACT_LEGAL_BODY,
            renderedText: rendered.renderedText,
            createdAt: now,
            updatedAt: now,
          };
          store.contracts.push(nextDraft);
          contract = nextDraft;
          event.contractId = nextDraft.id;
        } else {
          contract.dynamicFields = rendered.normalizedFields;
          contract.renderedText = rendered.renderedText;
          contract.updatedAt = now;
        }

        await saveGeneratedContract({
          eventId: event.id,
          version: contract.version,
          text: contract.renderedText,
        });

        const currentInvoice = getInvoiceByEvent(store, event.id);
        const nextInvoice = invoiceFromContract({
          invoice: currentInvoice,
          eventId: event.id,
          clientId: client.id,
          fields: contract.dynamicFields,
          services: event.servicesRequested,
          nowIso: now,
        });
        if (currentInvoice) {
          const index = store.invoices.findIndex((item) => item.id === currentInvoice.id);
          store.invoices[index] = nextInvoice;
        } else {
          store.invoices.push(nextInvoice);
        }
        event.invoiceId = nextInvoice.id;
      }
    }
  }

  if (typeof args.notes === "string") {
    event.latestNotes = args.notes;
    store.communications.push({
      id: createId("comm"),
      clientId: client.id,
      eventId: event.id,
      kind: "note",
      content: args.notes,
      createdAt: now,
    });
  }

  if (typeof args.ocrText === "string") {
    event.latestOcrText = args.ocrText;
  }

  if (args.profile) {
    const mergedProfile = sanitizeWorkspaceProfileAgainstOwner(
      mergeWorkspaceProfile(
      defaultWorkspaceProfile({
        existing: event.profile,
        client,
        event,
      }),
      args.profile
      ),
      ownerIdentity
    );
    event.profile = mergedProfile;
    syncPrimaryProfileToClient({
      client,
      event,
      profile: mergedProfile,
    });
    sanitizeClientAgainstOwner(client, ownerIdentity);
  }

  if (args.workspaceMeta) {
    const meta = args.workspaceMeta;
    const workspaceBoundsTouched =
      Object.prototype.hasOwnProperty.call(meta, "workspaceStartTimestamp") ||
      Object.prototype.hasOwnProperty.call(meta, "workspaceEndTimestamp");
    if (typeof meta.venue === "string") {
      event.venue = meta.venue.trim() || undefined;
    }
    if (meta.workspaceStartTimestamp === null) {
      event.workspaceStartTimestamp = undefined;
    } else if (typeof meta.workspaceStartTimestamp === "number" && Number.isFinite(meta.workspaceStartTimestamp)) {
      event.workspaceStartTimestamp = normalizeTimestamp(meta.workspaceStartTimestamp);
    }
    if (meta.workspaceEndTimestamp === null) {
      event.workspaceEndTimestamp = undefined;
    } else if (typeof meta.workspaceEndTimestamp === "number" && Number.isFinite(meta.workspaceEndTimestamp)) {
      event.workspaceEndTimestamp = normalizeTimestamp(meta.workspaceEndTimestamp);
    }
    if (workspaceBoundsTouched) {
      if (meta.workspaceStartTimestamp === null && meta.workspaceEndTimestamp === null) {
        event.workspaceDateBoundsLocked = false;
      } else if (
        typeof meta.workspaceStartTimestamp === "number" ||
        typeof meta.workspaceEndTimestamp === "number"
      ) {
        event.workspaceDateBoundsLocked = true;
      }
    }
    syncEventDateFromWorkspaceBounds(event);
    if (meta.stage) {
      event.stageOverride = meta.stage;
      if (meta.stage === "cancelled") {
        event.status = "cancelled";
        event.signedContract = false;
        event.initialDepositReceived = false;
        event.depositStatus = "none";
      } else if (meta.stage === "completed") {
        event.status = "completed";
        event.signedContract = true;
        event.initialDepositReceived = true;
        event.depositStatus = "received";
      } else if (meta.stage === "inquiry") {
        event.status = "inquiry_received";
        event.signedContract = false;
        event.initialDepositReceived = false;
        event.depositStatus = "none";
      } else {
        if (event.status === "cancelled" || event.status === "completed") {
          event.status = "inquiry_received";
        }
        event.signedContract = true;
        event.initialDepositReceived = true;
        event.depositStatus = "received";
      }
    }
    if (meta.status) {
      event.status = meta.status;
    }
    if (typeof meta.documentsCount === "number" && Number.isFinite(meta.documentsCount)) {
      event.manualDocumentsCount = Math.max(0, Math.floor(meta.documentsCount));
    } else if (meta.documentsCount === null) {
      event.manualDocumentsCount = undefined;
    }

    if (workspaceBoundsTouched && contract) {
      const boundedFields = applyWorkspaceBoundsToContractFields(contract.dynamicFields, event);
      if (JSON.stringify(boundedFields) !== JSON.stringify(contract.dynamicFields)) {
        const rendered = renderContract(boundedFields, contract.legalBody || CONTRACT_LEGAL_BODY, client.fullName);
        if (contract.status === "approved") {
          const nextDraft: Contract = {
            id: createId("contract"),
            eventId: event.id,
            clientId: client.id,
            version: contract.version + 1,
            status: "draft",
            dynamicFields: rendered.normalizedFields,
            legalBody: contract.legalBody || CONTRACT_LEGAL_BODY,
            renderedText: rendered.renderedText,
            createdAt: now,
            updatedAt: now,
          };
          store.contracts.push(nextDraft);
          contract = nextDraft;
          event.contractId = nextDraft.id;
        } else {
          contract.dynamicFields = rendered.normalizedFields;
          contract.renderedText = rendered.renderedText;
          contract.updatedAt = now;
        }
        await saveGeneratedContract({
          eventId: event.id,
          version: contract.version,
          text: contract.renderedText,
        });

        const currentInvoice = getInvoiceByEvent(store, event.id);
        const nextInvoice = invoiceFromContract({
          invoice: currentInvoice,
          eventId: event.id,
          clientId: client.id,
          fields: contract.dynamicFields,
          services: event.servicesRequested,
          nowIso: now,
        });
        if (currentInvoice) {
          const idx = store.invoices.findIndex((item) => item.id === currentInvoice.id);
          store.invoices[idx] = nextInvoice;
        } else {
          store.invoices.push(nextInvoice);
        }
        event.invoiceId = nextInvoice.id;
      }
    }

    if (typeof meta.contractTotalAmount === "number" && Number.isFinite(meta.contractTotalAmount) && meta.contractTotalAmount >= 0 && contract) {
      const targetTotal = normalizeCurrencyAmount(meta.contractTotalAmount);
      const currentTotal = normalizeCurrencyAmount(contract.dynamicFields.totalAmount || 0);
      if (Math.abs(targetTotal - currentTotal) >= CONTRACT_CHANGE_TOLERANCE) {
        const updatedFields: ContractDynamicFields = structuredClone(contract.dynamicFields);
        const delta = targetTotal - currentTotal;
        updatedFields.travelAmount = normalizeCurrencyAmount(Math.max(0, (updatedFields.travelAmount || 0) + delta));

        let rendered = renderContract(
          applyWorkspaceBoundsToContractFields(updatedFields, event),
          contract.legalBody || CONTRACT_LEGAL_BODY,
          client.fullName
        );
        let remainder = normalizeCurrencyAmount(targetTotal - (rendered.normalizedFields.totalAmount || 0));
        if (Math.abs(remainder) >= CONTRACT_CHANGE_TOLERANCE && rendered.normalizedFields.eventDetails.length) {
          const first = rendered.normalizedFields.eventDetails[0];
          const baseAmount =
            typeof first.manualOverridePrice === "number" && Number.isFinite(first.manualOverridePrice)
              ? first.manualOverridePrice
              : first.amount;
          const nextOverride = normalizeCurrencyAmount(Math.max(0, baseAmount + remainder));
          rendered.normalizedFields.eventDetails[0] = {
            ...first,
            manualOverridePrice: nextOverride,
          };
          rendered = renderContract(
            applyWorkspaceBoundsToContractFields(rendered.normalizedFields, event),
            contract.legalBody || CONTRACT_LEGAL_BODY,
            client.fullName
          );
        }

        if (contract.status === "approved") {
          const nextDraft: Contract = {
            id: createId("contract"),
            eventId: event.id,
            clientId: client.id,
            version: contract.version + 1,
            status: "draft",
            dynamicFields: rendered.normalizedFields,
            legalBody: contract.legalBody || CONTRACT_LEGAL_BODY,
            renderedText: rendered.renderedText,
            createdAt: now,
            updatedAt: now,
          };
          store.contracts.push(nextDraft);
          contract = nextDraft;
          event.contractId = nextDraft.id;
        } else {
          contract.dynamicFields = rendered.normalizedFields;
          contract.renderedText = rendered.renderedText;
          contract.updatedAt = now;
        }
        await saveGeneratedContract({
          eventId: event.id,
          version: contract.version,
          text: contract.renderedText,
        });

        const currentInvoice = getInvoiceByEvent(store, event.id);
        const nextInvoice = invoiceFromContract({
          invoice: currentInvoice,
          eventId: event.id,
          clientId: client.id,
          fields: contract.dynamicFields,
          services: event.servicesRequested,
          nowIso: now,
        });
        if (currentInvoice) {
          const idx = store.invoices.findIndex((item) => item.id === currentInvoice.id);
          store.invoices[idx] = nextInvoice;
        } else {
          store.invoices.push(nextInvoice);
        }
        event.invoiceId = nextInvoice.id;
      }
    }
  }

  if (typeof args.signedContract === "boolean") {
    event.signedContract = args.signedContract;
    if (args.signedContract) {
      event.status = "contract_approved";
    } else if (event.status === "contract_approved" || event.status === "booked") {
      event.status = "contract_drafted";
    }
  }

  if (typeof args.initialDepositReceived === "boolean") {
    event.initialDepositReceived = args.initialDepositReceived;
    event.depositStatus = args.initialDepositReceived ? "received" : "none";
  }

  if (typeof args.fullInvoicePaid === "boolean") {
    const invoice = getInvoiceByEvent(store, event.id);
    if (invoice) {
      if (args.fullInvoicePaid) {
        invoice.status = "paid";
        event.initialDepositReceived = true;
        event.depositStatus = "received";
      } else {
        const depositSent = Boolean(event.initialDepositReceived || event.depositStatus === "received");
        invoice.status = depositSent ? "paid_partial" : "sent";
      }
      invoice.updatedAt = now;
    }
  }

  if (typeof args.adjustedContractSigned === "boolean") {
    event.adjustedContractSigned = args.adjustedContractSigned;
    if (args.adjustedContractSigned) {
      event.needsAdjustedContractSignature = false;
    }
  }

  if (typeof args.additionalDepositCollected === "boolean") {
    event.additionalDepositCollected = args.additionalDepositCollected;
    if (args.additionalDepositCollected) {
      event.needsAdditionalDepositCollection = false;
      event.additionalDepositAmountDue = undefined;
    }
  }

  if (args.regenerateDraftEmail) {
    const rawFeed = (event.latestOcrText || "").trim();
    const sourceContext = rawFeed || (latestInquiry?.extractedText || "").trim();
    if (sourceContext) {
      const inquiryPayload = buildInquiryProcessingPayload({ messageText: sourceContext });
      const heuristicExtraction = extractInquiryFromText(inquiryPayload.combinedText, inquiryPayload);
      const extractionResult = await extractInquiryWithCodex({
        payload: inquiryPayload,
        fallback: heuristicExtraction,
        ownerIdentity,
      });
      const extractedForContext = withWorkspaceContextExtracted({
        extracted: sanitizeExtractedAgainstOwner(extractionResult.extracted, ownerIdentity),
        client,
        event,
        contract,
      });
      await refreshWorkspaceProfileFromContext({
        event,
        client,
        extracted: extractedForContext,
        rawText: sourceContext,
        ownerIdentity,
      });

      const stageForEmail = detectStage(event, contract, getInvoiceByEvent(store, event.id));
      const dateAvailabilityStatus = classifyDateAvailabilityFromWorkspaces({
        store,
        targetEventId: event.id,
        extracted: extractedForContext,
        fallbackEvent: event,
      });
      const latestContext = latestInboundContextForDraft(sourceContext) || sourceContext;
      const availabilityAlreadyShared = availabilityAlreadyCommunicated(sourceContext);
      const preferCheckIn = shouldGenerateCheckInDraft(sourceContext);
      const quoteAlreadyShared = quoteInfoAlreadyShared(sourceContext);
      const hasPriorContext = hasPriorConversationContext({
        inquiryCount: event.inquiryIds.length,
        rawFeed: sourceContext,
      });
      const cancellationDetected =
        clientContextIndicatesCancellation(latestContext) || event.status === "cancelled";
      const toneExamples = approvedDraftToneExamples({
        store,
        clientId: client.id,
      });
      const emailMissingFields = extractedForContext.missingFields;
      const confirmedDetails = buildEmailConfirmedDetails({
        client,
        event,
        contract,
        extracted: extractedForContext,
      });
      const canSendContract = contractReadyToSend({
        contract,
        missingFields: emailMissingFields,
      });
      const fallbackDraft = buildDraftEmail({
        stage: stageForEmail,
        status: cancellationDetected ? "cancelled" : event.status,
        clientName: client.fullName,
        extracted: extractedForContext,
        missingFields: emailMissingFields,
        dateAvailabilityStatus,
        availabilityAlreadyShared,
        services: event.servicesRequested,
        baseRatePerHour: baseRate,
        hasPriorContext,
        latestContext,
        rawContext: sourceContext,
        preferCheckIn,
        quoteAlreadyShared,
        contractReadyToSend: canSendContract,
      });
      const emailResult = await generateEmailDraftWithCodex({
        stage: stageForEmail,
        status: cancellationDetected ? "cancelled" : event.status,
        clientName: client.fullName,
        extracted: extractedForContext,
        missingFields: emailMissingFields,
        latestContext,
        fullContext: sourceContext,
        contextSummary: event.latestInquirySummary,
        hasPriorContext,
        preferCheckIn,
        quoteAlreadyShared,
        approvedToneExamples: toneExamples,
        confirmedDetails,
        contractReadyToSend: canSendContract,
        dateAvailabilityStatus,
        availabilityAlreadyShared,
        fallbackDraft,
      });
      let nextDraft = emailResult.draft?.trim() || fallbackDraft;
      if (emailMissingFields.includes("event_time") && !/(timeline|time\s*stamps?|start.{0,20}end)/i.test(nextDraft.toLowerCase())) {
        nextDraft = fallbackDraft;
      }
      if (preferCheckIn && !/(check.?ing in|need anything else|set up a call|hop on a call|happy to set up a call)/i.test(nextDraft.toLowerCase())) {
        nextDraft = fallbackDraft;
      }
      nextDraft = enforceDraftDateConsistency({
        draft: nextDraft,
        fallbackDraft,
        extracted: extractedForContext,
      });
      nextDraft = enforceDraftAvailabilityConsistency({
        draft: nextDraft,
        fallbackDraft,
        dateAvailabilityStatus,
        availabilityAlreadyShared,
      });
      nextDraft = enforceContractReadyQuoteBreakdown({
        draft: nextDraft,
        fallbackDraft,
        contractReadyToSend: canSendContract,
        dateAvailabilityStatus,
      });
      nextDraft = enforceHumanInterventionTag({
        draft: nextDraft,
        latestContext,
      });
      if (cancellationDetected && !draftIsSupportiveForCancellation(nextDraft)) {
        nextDraft = fallbackDraft;
      }
      event.latestDraftEmail = nextDraft;
      store.communications.push({
        id: createId("comm"),
        clientId: client.id,
        eventId: event.id,
        kind: "draft_email",
        content: nextDraft,
        createdAt: now,
      });
      if (shouldUseCodexForAdmin()) {
        event.latestNotes = `${event.latestNotes ? `${event.latestNotes} ` : ""}[email_regen:${codexSignalLabel(emailResult.mode)}:${emailResult.model}]`;
      }
    }
  }

  if (args.reanalyzeFromRaw) {
    const rawFeed = (event.latestOcrText || "").trim();
    if (rawFeed) {
      const inquiryPayload = buildInquiryProcessingPayload({ messageText: rawFeed });
      const heuristicExtraction = extractInquiryFromText(inquiryPayload.combinedText, inquiryPayload);
      const extractionResult = await extractInquiryWithCodex({
        payload: inquiryPayload,
        fallback: heuristicExtraction,
        ownerIdentity,
      });
      const extracted = sanitizeExtractedAgainstOwner(extractionResult.extracted, ownerIdentity);
      const extractedForContext = withWorkspaceContextExtracted({
        extracted,
        client,
        event,
        contract,
      });
      mergeClientProfileFromExtracted({ client, extracted: extractedForContext });
      sanitizeClientAgainstOwner(client, ownerIdentity);
      mergeEventProfileFromExtracted({ event, extracted: extractedForContext });
      applyExtractedDateWindow(event, extractedForContext, {
        rawText: rawFeed,
      });
      await refreshWorkspaceProfileFromContext({
        event,
        client,
        extracted: extractedForContext,
        rawText: rawFeed,
        ownerIdentity,
      });

      const stageForSummary = detectStage(event, contract, getInvoiceByEvent(store, event.id));
      const fallbackSummary = buildFallbackInquirySummary({
        extracted: extractedForContext,
        stage: stageForSummary,
        rawText: rawFeed,
      });
      const summaryResult = await summarizeInquiryWithCodex({
        rawText: rawFeed,
        extracted: extractedForContext,
        stage: stageForSummary,
        fallbackSummary,
      });
      event.latestInquirySummary = summaryResult.summary;
      summaryUpdatedThisRequest = true;

      const dateAvailabilityStatus = classifyDateAvailabilityFromWorkspaces({
        store,
        targetEventId: event.id,
        extracted: extractedForContext,
        fallbackEvent: event,
      });
      const latestContext = latestInboundContextForDraft(rawFeed);
      const availabilityAlreadyShared = availabilityAlreadyCommunicated(rawFeed);
      const preferCheckIn = shouldGenerateCheckInDraft(rawFeed);
      const quoteAlreadyShared = quoteInfoAlreadyShared(rawFeed);
      const hasPriorContext = hasPriorConversationContext({
        inquiryCount: event.inquiryIds.length,
        rawFeed,
      });
      const cancellationDetected =
        clientContextIndicatesCancellation(latestContext || rawFeed) || event.status === "cancelled";
      const toneExamples = approvedDraftToneExamples({
        store,
        clientId: client.id,
      });
      const emailMissingFields = extractedForContext.missingFields;
      const confirmedDetails = buildEmailConfirmedDetails({
        client,
        event,
        contract,
        extracted: extractedForContext,
      });
      const canSendContract = contractReadyToSend({
        contract,
        missingFields: emailMissingFields,
      });

      const fallbackDraft = buildDraftEmail({
        stage: stageForSummary,
        status: cancellationDetected ? "cancelled" : event.status,
        clientName: client.fullName,
        extracted: extractedForContext,
        missingFields: emailMissingFields,
        dateAvailabilityStatus,
        availabilityAlreadyShared,
        services: event.servicesRequested,
        baseRatePerHour: baseRate,
        hasPriorContext,
        latestContext: latestContext || rawFeed,
        rawContext: rawFeed,
        preferCheckIn,
        quoteAlreadyShared,
        contractReadyToSend: canSendContract,
      });
      const emailResult = await generateEmailDraftWithCodex({
        stage: stageForSummary,
        status: cancellationDetected ? "cancelled" : event.status,
        clientName: client.fullName,
        extracted: extractedForContext,
        missingFields: emailMissingFields,
        latestContext: latestContext || rawFeed,
        fullContext: rawFeed,
        contextSummary: event.latestInquirySummary,
        hasPriorContext,
        preferCheckIn,
        quoteAlreadyShared,
        approvedToneExamples: toneExamples,
        confirmedDetails,
        contractReadyToSend: canSendContract,
        dateAvailabilityStatus,
        availabilityAlreadyShared,
        fallbackDraft,
      });
      let nextDraft = emailResult.draft?.trim() || fallbackDraft;
      if (emailMissingFields.includes("event_time") && !/(timeline|time\s*stamps?|start.{0,20}end)/i.test(nextDraft.toLowerCase())) {
        nextDraft = fallbackDraft;
      }
      if (preferCheckIn && !/(check.?ing in|need anything else|set up a call|hop on a call|happy to set up a call)/i.test(nextDraft.toLowerCase())) {
        nextDraft = fallbackDraft;
      }
      nextDraft = enforceDraftDateConsistency({
        draft: nextDraft,
        fallbackDraft,
        extracted: extractedForContext,
      });
      nextDraft = enforceDraftAvailabilityConsistency({
        draft: nextDraft,
        fallbackDraft,
        dateAvailabilityStatus,
        availabilityAlreadyShared,
      });
      nextDraft = enforceContractReadyQuoteBreakdown({
        draft: nextDraft,
        fallbackDraft,
        contractReadyToSend: canSendContract,
        dateAvailabilityStatus,
      });
      nextDraft = enforceHumanInterventionTag({
        draft: nextDraft,
        latestContext: latestContext || rawFeed,
      });
      if (cancellationDetected && !draftIsSupportiveForCancellation(nextDraft)) {
        nextDraft = fallbackDraft;
      }
      event.latestDraftEmail = nextDraft;
      store.communications.push({
        id: createId("comm"),
        clientId: client.id,
        eventId: event.id,
        kind: "draft_email",
        content: nextDraft,
        createdAt: now,
      });

      if (!contract) {
        const initialFields = refreshDynamicFieldsFromExtraction(undefined, extractedForContext, baseRate);
        const pricedFields = applyPricingDirectiveFromRawContext(initialFields, rawFeed);
        const boundedFields = applyWorkspaceBoundsToContractFields(pricedFields, event);
        const rendered = renderContract(boundedFields, CONTRACT_LEGAL_BODY, client.fullName);
        contract = {
          id: createId("contract"),
          eventId: event.id,
          clientId: client.id,
          version: 1,
          status: "draft",
          dynamicFields: rendered.normalizedFields,
          legalBody: CONTRACT_LEGAL_BODY,
          renderedText: rendered.renderedText,
          createdAt: now,
          updatedAt: now,
        };
        store.contracts.push(contract);
        event.contractId = contract.id;
        await saveGeneratedContract({ eventId: event.id, version: 1, text: rendered.renderedText });
      } else {
        const refreshedFields = refreshDynamicFieldsFromExtraction(contract.dynamicFields, extractedForContext, baseRate);
        const pricedFields = applyPricingDirectiveFromRawContext(refreshedFields, rawFeed);
        const boundedFields = applyWorkspaceBoundsToContractFields(pricedFields, event);
        const rendered = renderContract(boundedFields, contract.legalBody || CONTRACT_LEGAL_BODY, client.fullName);
        if (contract.status === "approved") {
          const newVersion = contract.version + 1;
          const nextDraft: Contract = {
            id: createId("contract"),
            eventId: event.id,
            clientId: client.id,
            version: newVersion,
            status: "draft",
            dynamicFields: rendered.normalizedFields,
            legalBody: contract.legalBody || CONTRACT_LEGAL_BODY,
            renderedText: rendered.renderedText,
            createdAt: now,
            updatedAt: now,
          };
          store.contracts.push(nextDraft);
          contract = nextDraft;
          event.contractId = nextDraft.id;
        } else {
          contract.dynamicFields = rendered.normalizedFields;
          contract.renderedText = rendered.renderedText;
          contract.updatedAt = now;
        }
        await saveGeneratedContract({ eventId: event.id, version: contract.version, text: contract.renderedText });
      }

      const currentInvoice = getInvoiceByEvent(store, event.id);
      const nextInvoice = invoiceFromContract({
        invoice: currentInvoice,
        eventId: event.id,
        clientId: client.id,
        fields: contract.dynamicFields,
        services: event.servicesRequested,
        nowIso: now,
      });
      if (currentInvoice) {
        const idx = store.invoices.findIndex((item) => item.id === currentInvoice.id);
        store.invoices[idx] = nextInvoice;
      } else {
        store.invoices.push(nextInvoice);
      }
      event.invoiceId = nextInvoice.id;

      if (shouldUseCodexForAdmin()) {
        event.latestNotes = `${event.latestNotes ? `${event.latestNotes} ` : ""}[extract:${codexSignalLabel(extractionResult.mode)}:${extractionResult.model}] [summary:${codexSignalLabel(summaryResult.mode)}:${summaryResult.model}] [email:${codexSignalLabel(emailResult.mode)}:${emailResult.model}]`;
      }
    }
  }

  if (args.contractFields) {
    const shouldVersion = !!contract && (event.stage === "execution" || contract.status === "approved");
    const baseVersion = contract?.version || 0;
    const pricedFields: ContractDynamicFields = {
      ...args.contractFields,
      eventDetails: applyDerivedAmountsFromTime({
        rows: args.contractFields.eventDetails || [],
        previousRows: contract?.dynamicFields.eventDetails || [],
        baseRate,
      }),
    };
    const policyFields = applyWorkspaceBoundsToContractFields(applyContractDatePolicy(pricedFields), event);
    const rendered = renderContract(policyFields, contract?.legalBody || CONTRACT_LEGAL_BODY, client.fullName);

    if (!contract || shouldVersion) {
      const newContract: Contract = {
        id: createId("contract"),
        eventId: event.id,
        clientId: client.id,
        version: baseVersion + 1,
        status: "draft",
        dynamicFields: rendered.normalizedFields,
        legalBody: contract?.legalBody || CONTRACT_LEGAL_BODY,
        renderedText: rendered.renderedText,
        createdAt: now,
        updatedAt: now,
      };
      store.contracts.push(newContract);
      contract = newContract;
      event.contractId = newContract.id;
    } else {
      contract.dynamicFields = rendered.normalizedFields;
      contract.renderedText = rendered.renderedText;
      contract.updatedAt = now;
    }

    await saveGeneratedContract({
      eventId: event.id,
      version: contract.version,
      text: contract.renderedText,
    });

    const currentInvoice = getInvoiceByEvent(store, event.id);
    const nextInvoice = invoiceFromContract({
      invoice: currentInvoice,
      eventId: event.id,
      clientId: client.id,
      fields: contract.dynamicFields,
      services: event.servicesRequested,
      nowIso: now,
    });

    if (currentInvoice) {
      const idx = store.invoices.findIndex((item) => item.id === currentInvoice.id);
      store.invoices[idx] = nextInvoice;
    } else {
      store.invoices.push(nextInvoice);
    }
    event.invoiceId = nextInvoice.id;
  }

  if (args.approveContractFields && contract) {
    const approvedContract = (contract.renderedText || "").trim();
    if (approvedContract) {
      event.latestOcrText = appendWorkspaceContext(
        event.latestOcrText,
        buildApprovedContextBlock({
          artifactType: "contract",
          content: approvedContract,
        })
      );
    }
  }

  if (args.approveContract && contract) {
    const priorApprovedTotal = event.lastApprovedContractTotalAmount;
    const priorApprovedDeposit = event.lastApprovedContractDepositAmount;
    const currentTotal = Number(contract.dynamicFields.totalAmount || 0);
    const currentDeposit = Number(contract.dynamicFields.depositAmount || 0);

    contract.status = "approved";
    contract.updatedAt = now;

    const invoiceAtApproval = getInvoiceByEvent(store, event.id);
    const stageAtApproval = detectStage(event, contract, invoiceAtApproval);
    if (
      stageAtApproval === "in_contract" &&
      typeof priorApprovedTotal === "number" &&
      typeof priorApprovedDeposit === "number"
    ) {
      const totalChanged = Math.abs(currentTotal - priorApprovedTotal) >= CONTRACT_CHANGE_TOLERANCE;
      const depositChanged = Math.abs(currentDeposit - priorApprovedDeposit) >= CONTRACT_CHANGE_TOLERANCE;
      const depositIncrease = currentDeposit - priorApprovedDeposit;

      if (totalChanged || depositChanged) {
        event.needsAdjustedContractSignature = true;
        event.adjustedContractSigned = false;
      }

      if (
        depositChanged &&
        depositIncrease >= CONTRACT_CHANGE_TOLERANCE &&
        (event.initialDepositReceived || event.depositStatus === "received")
      ) {
        event.needsAdditionalDepositCollection = true;
        event.additionalDepositCollected = false;
        event.additionalDepositAmountDue = normalizeCurrencyAmount(depositIncrease);
      } else if (depositChanged && depositIncrease < CONTRACT_CHANGE_TOLERANCE) {
        event.needsAdditionalDepositCollection = false;
        event.additionalDepositCollected = false;
        event.additionalDepositAmountDue = undefined;
      }
    }

    event.lastApprovedContractVersion = contract.version;
    event.lastApprovedContractTotalAmount = currentTotal;
    event.lastApprovedContractDepositAmount = currentDeposit;

    const approvedContract = (contract.renderedText || "").trim();
    if (approvedContract) {
      event.latestOcrText = appendWorkspaceContext(
        event.latestOcrText,
        buildApprovedContextBlock({
          artifactType: "contract",
          content: approvedContract,
        })
      );
    }
    addContractMemorySnapshot({
      store,
      clientId: client.id,
      event,
      contract,
      now,
    });
  }

  if (args.markDepositReceived) {
    event.depositStatus = "received";
    event.initialDepositReceived = true;
    event.status = "deposit_received";
    const invoice = getInvoiceByEvent(store, event.id);
    if (invoice) {
      invoice.status = invoice.balanceRemaining > 0 ? "paid_partial" : "paid";
      invoice.updatedAt = now;
    }
  }

  if (args.addToMemory && !args.approveContract) {
    if (contract) {
      addContractMemorySnapshot({
        store,
        clientId: client.id,
        event,
        contract,
        now,
        changeSummary: args.memoryChangeSummary,
      });
    } else if (latestInquiry) {
      const generatedOutput = event.latestDraftEmail;
      store.trainingExamples.push({
        id: createId("train"),
        clientId: client.id,
        eventId: event.id,
        stage: event.stage,
        originalInquiry: latestInquiry.extractedText,
        generatedOutput,
        finalOutput: args.memoryFinalOutput || generatedOutput,
        decision: args.memoryDecision || "approved",
        changeSummary: args.memoryChangeSummary,
        rawContextSnapshot: (event.latestOcrText || latestInquiry.extractedText || "").trim(),
        createdAt: now,
      });
    }
  }

  const latestContext = latestInquiry?.extractedText || latestContextFromRawFeed(event.latestOcrText || "");
  applyCancellationSignal(event, latestContext);

  const currentContract = contract || getLatestContract(store, event.id);
  const currentInvoice = getInvoiceByEvent(store, event.id);
  const shouldRecomputeDateRange = Boolean(
    args.reanalyzeFromRaw ||
      args.approveDraftEmail ||
      args.approveContractFields ||
      args.approveContract ||
      args.contractFields
  );
  const hasWorkspaceBounds =
    typeof event.workspaceStartTimestamp === "number" &&
    typeof event.workspaceEndTimestamp === "number";
  const boundsLocked = event.workspaceDateBoundsLocked === true;
  recomputeWorkspaceDateRange(event, currentContract, {
    force: shouldRecomputeDateRange && !(hasWorkspaceBounds && boundsLocked),
  });
  syncEventDateFromWorkspaceBounds(event);
  applyTemporalWorkspaceStatus(event, { contract: currentContract, invoice: currentInvoice });
  event.stage = detectStage(event, currentContract, currentInvoice);

  const summaryRelevantFieldsTouched = Boolean(
    typeof args.emailDraft === "string" ||
      typeof args.notes === "string" ||
      typeof args.ocrText === "string" ||
      args.profile ||
      args.workspaceMeta ||
      args.contractFields ||
      typeof args.signedContract === "boolean" ||
      typeof args.initialDepositReceived === "boolean" ||
      typeof args.fullInvoicePaid === "boolean" ||
      typeof args.adjustedContractSigned === "boolean" ||
      typeof args.additionalDepositCollected === "boolean" ||
      args.approveContractFields ||
      args.approveContract ||
      args.markDepositReceived ||
      args.addToMemory ||
      args.regenerateDraftEmail ||
      args.approveDraftEmail ||
      args.reanalyzeFromRaw
  );

  if (summaryRelevantFieldsTouched && !summaryUpdatedThisRequest) {
    const rawFeed = (event.latestOcrText || "").trim();
    if (rawFeed) {
      const inquiryPayload = buildInquiryProcessingPayload({ messageText: rawFeed });
      const heuristicExtraction = extractInquiryFromText(inquiryPayload.combinedText, inquiryPayload);
      const extractionResult = await extractInquiryWithCodex({
        payload: inquiryPayload,
        fallback: heuristicExtraction,
        ownerIdentity,
      });
      const extractedForSummary = withWorkspaceContextExtracted({
        extracted: sanitizeExtractedAgainstOwner(extractionResult.extracted, ownerIdentity),
        client,
        event,
        contract: currentContract,
      });
      const fallbackSummary = buildFallbackInquirySummary({
        extracted: extractedForSummary,
        stage: event.stage,
        rawText: rawFeed,
      });
      const summaryResult = await summarizeInquiryWithCodex({
        rawText: rawFeed,
        extracted: extractedForSummary,
        stage: event.stage,
        fallbackSummary,
      });
      event.latestInquirySummary = summaryResult.summary;
      summaryUpdatedThisRequest = true;
      if (shouldUseCodexForAdmin()) {
        event.latestNotes = `${event.latestNotes ? `${event.latestNotes} ` : ""}[summary_update:${codexSignalLabel(summaryResult.mode)}:${summaryResult.model}]`;
      }
    }
  }

  await applyDraftFollowUpWaitState({
    store,
    event,
    client,
    contract: currentContract,
    invoice: currentInvoice,
    baseRatePerHour: baseRate,
    nowTs: Date.now(),
  });

  if (event.stage === "execution" && latestInquiry && currentContract && currentInvoice) {
    const fallbackAmendment = buildFallbackAmendmentSuggestion({
      contractText: currentContract.renderedText,
      inboundMessage: latestInquiry.extractedText,
      invoiceAmount: currentInvoice.amount,
    });
    const amendmentResult = await suggestAmendmentWithCodex({
      inboundMessage: latestInquiry.extractedText,
      contractText: currentContract.renderedText,
      invoiceHint: `total=${currentInvoice.amount} deposit=${currentInvoice.depositAmount} remaining=${currentInvoice.balanceRemaining} due=${currentInvoice.paymentDueDate || ""}`,
      fallbackSuggestion: fallbackAmendment,
    });
    event.amendmentSuggestion = amendmentResult.suggestion;
    if (shouldUseCodexForAdmin()) {
      event.latestNotes = `${event.latestNotes ? `${event.latestNotes} ` : ""}[amendment:${codexSignalLabel(amendmentResult.mode)}:${amendmentResult.model}]`;
    }
  }

  event.updatedAt = now;
  await writeStore(store);
  await persistClientMarkdown(store, client.id);

  return getWorkspaceByEventId(event.id);
}
