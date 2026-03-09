import type { BookingStage, Client, Event, ExtractedInquiry, WorkspaceProfile } from "../types/models";
import type { MatchResult } from "../inquiries/matching";
import type { InquiryProcessingPayload } from "../inquiries/payload";
import { toInquiryProcessingJson } from "../inquiries/payload";
import { coerceExtractedLocationToCity, normalizeLocationCandidate } from "../inquiries/location";
import { normalizeTimestamp, parseDateToTimestamp, timestampToIsoDate } from "../utils/date";
import { getAdminAiEnvConfig, validateRuntimeConfig } from "../config/runtime-config";

type CodexService = "extract" | "match" | "email" | "amendment" | "summary";

type CodexMode = "heuristic" | "codex" | "codex_fallback";

export interface AdminOwnerIdentity {
  name?: string;
  email?: string;
  phone?: string;
  instagramHandle?: string;
}

function codexEnabled(): boolean {
  const ai = getAdminAiEnvConfig();
  return ai.enabled && Boolean(ai.apiKey);
}

function modelForService(service: CodexService): string {
  const models = getAdminAiEnvConfig().models;
  if (service === "extract") return models.extract;
  if (service === "match") return models.match;
  if (service === "email") return models.email;
  if (service === "amendment") return models.amendment;
  return models.summary;
}

function fallbackModelsForService(service: CodexService): string[] {
  const models = getAdminAiEnvConfig().models;
  if (service === "extract") {
    return [
      models.email || "",
      "codex-5.3",
      "gpt-4.1-mini",
      "gpt-4o-mini",
    ].filter(Boolean);
  }
  if (service === "email" || service === "amendment") {
    return ["codex-5.3", "gpt-4.1-mini", "gpt-4o-mini"];
  }
  return ["gpt-4.1-mini", "gpt-4o-mini"];
}

function modelCandidatesForService(service: CodexService): string[] {
  const configured = modelForService(service);
  const candidates = [configured, ...fallbackModelsForService(service)].filter(
    (value): value is string => Boolean(value)
  );
  return Array.from(new Set(candidates));
}

function safeLower(value?: string): string {
  return (value || "").trim().toLowerCase();
}

function normalizeDateLikeText(value?: string | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim();
  if (!cleaned) return undefined;
  const lowered = cleaned.toLowerCase();
  const placeholders = new Set([
    "unknown",
    "n/a",
    "na",
    "none",
    "null",
    "nil",
    "tbd",
    "not sure",
    "not provided",
    "not specified",
    "undecided",
  ]);
  if (placeholders.has(lowered)) return undefined;
  return cleaned;
}

function normalizeOwnerIdentity(identity?: AdminOwnerIdentity): AdminOwnerIdentity {
  return {
    name: (identity?.name || "").trim(),
    email: safeLower(identity?.email),
    phone: (identity?.phone || "").replace(/[^\d+]/g, ""),
    instagramHandle: safeLower(identity?.instagramHandle || "").replace(/^@+/, ""),
  };
}

function ownerIdentityPrompt(identity?: AdminOwnerIdentity): string {
  const owner = normalizeOwnerIdentity(identity);
  if (!owner.name && !owner.email && !owner.phone && !owner.instagramHandle) {
    return "";
  }
  const ownerLines = [
    owner.name ? `name=${owner.name}` : "",
    owner.email ? `email=${owner.email}` : "",
    owner.phone ? `phone=${owner.phone}` : "",
    owner.instagramHandle ? `instagram=@${owner.instagramHandle}` : "",
  ].filter(Boolean);
  return `\nOwner identity (this is the DJ/me, not a client): ${ownerLines.join(", ")}. Never map this owner identity into workspace client/planner/vendor fields. If owner identity appears in signatures, sent messages, or platform headers, ignore it for extracted client data.`;
}

function normalizeWorkspaceEventType(value?: string | null): string {
  const lowered = safeLower(value || undefined);
  return lowered.includes("wedding") ? "Wedding" : "Event";
}

function normalizePersonName(value?: string | null): string | undefined {
  if (!value || typeof value !== "string") return undefined;
  const cleaned = value.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;

  const parts = cleaned.split(" ").filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return undefined;
  if (!parts.every((part) => /^[A-Za-z][A-Za-z.'-]*$/.test(part))) return undefined;

  const lowered = cleaned.toLowerCase();
  const blocked = [
    "gmail",
    "yahoo",
    "outlook",
    "hours ago",
    "to me",
    "wedding",
    "event",
    "delivered",
    "message",
    "read",
    "sent",
    "share your name",
  ];
  if (blocked.some((term) => lowered.includes(term))) return undefined;

  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join(" ");
}

function isLikelyInternalDjName(value?: string): boolean {
  const lowered = (value || "").trim().toLowerCase();
  if (!lowered) return false;
  return lowered.includes("anupya") || lowered.includes("nalamalapu") || lowered.includes("dj anupya");
}

export function resolveClientNameFromHints(args: {
  aiClientName?: string | null;
  fallbackClientName?: string;
  signatureNameHint?: string;
  senderNameHint?: string;
}): string | undefined {
  const signature = normalizePersonName(args.signatureNameHint);
  const sender = normalizePersonName(args.senderNameHint);
  if (signature && sender && isLikelyInternalDjName(signature) && !isLikelyInternalDjName(sender)) {
    return sender;
  }
  if (signature) {
    return signature;
  }

  const aiName = normalizePersonName(args.aiClientName);
  const fallback = normalizePersonName(args.fallbackClientName);

  return aiName || fallback || sender;
}

function normalizeServices(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((item) => (typeof item === "string" ? item.trim().toLowerCase() : ""))
    .filter(Boolean);
}

function normalizeInstagramHandle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\s+/g, "").trim().toLowerCase().replace(/^@+/, "");
  if (!cleaned) return undefined;
  if (!/^[a-z0-9._]{2,30}$/.test(cleaned)) return undefined;
  if (/\.(com|net|org|edu|gov|io|co)$/i.test(cleaned)) return undefined;
  return `@${cleaned}`;
}

function normalizeProfileField(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

function normalizeWorkspaceProfilePatch(value: unknown): Partial<WorkspaceProfile> {
  if (!value || typeof value !== "object") return {};
  const row = value as Record<string, unknown>;
  const customFields = Array.isArray(row.customFields)
    ? row.customFields
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const field = item as Record<string, unknown>;
          const key = normalizeProfileField(field.key);
          const fieldValue = normalizeProfileField(field.value);
          if (!key && !fieldValue) return null;
          return { key, value: fieldValue };
        })
        .filter((item): item is { key: string; value: string } => Boolean(item))
    : [];
  return {
    primaryClientName: normalizeProfileField(row.primaryClientName),
    primaryEmail: normalizeProfileField(row.primaryEmail),
    primaryPhone: normalizeProfileField(row.primaryPhone),
    primaryInstagramHandle: normalizeProfileField(row.primaryInstagramHandle),
    secondaryClientName: normalizeProfileField(row.secondaryClientName),
    secondaryEmail: normalizeProfileField(row.secondaryEmail),
    secondaryPhone: normalizeProfileField(row.secondaryPhone),
    secondaryInstagramHandle: normalizeProfileField(row.secondaryInstagramHandle),
    weddingPlannerName: normalizeProfileField(row.weddingPlannerName),
    weddingPlannerEmail: normalizeProfileField(row.weddingPlannerEmail),
    weddingPlannerPhone: normalizeProfileField(row.weddingPlannerPhone),
    weddingPlannerInstagramHandle: normalizeProfileField(row.weddingPlannerInstagramHandle),
    avVendorName: normalizeProfileField(row.avVendorName),
    avVendorEmail: normalizeProfileField(row.avVendorEmail),
    avVendorPhone: normalizeProfileField(row.avVendorPhone),
    avVendorInstagramHandle: normalizeProfileField(row.avVendorInstagramHandle),
    customFields,
  };
}

function normalizeTimelineSegments(
  value: unknown
): Array<{ title: string; time: string; date?: string; notes?: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  const rows: Array<{ title: string; time: string; date?: string; notes?: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const title = typeof row.title === "string" ? row.title.trim() : "";
    const time = typeof row.time === "string" ? row.time.trim() : "";
    const date = typeof row.date === "string" ? row.date.trim() : undefined;
    const notes = typeof row.notes === "string" ? row.notes.trim() : undefined;
    if (!title || !time) continue;
    rows.push({ title, time, date, notes });
  }
  return rows;
}

function timelineKey(row: { title: string; time: string; date?: string }): string {
  return `${row.title.toLowerCase().replace(/\s+/g, " ").trim()}|${row.time.toLowerCase().replace(/\s+/g, "")}|${(row.date || "").trim()}`;
}

function dedupeTimelineSegments(
  rows: Array<{ title: string; time: string; date?: string; notes?: string }>
): Array<{ title: string; time: string; date?: string; notes?: string }> {
  const map = new Map<string, { title: string; time: string; date?: string; notes?: string }>();
  for (const row of rows) {
    const key = timelineKey(row);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, row);
      continue;
    }
    map.set(key, {
      ...existing,
      notes: existing.notes || row.notes,
      date: existing.date || row.date,
    });
  }
  return Array.from(map.values());
}

function mergeTimelineSegmentsPreferCoverage(args: {
  aiTimeline: Array<{ title: string; time: string; date?: string; notes?: string }>;
  fallbackTimeline: Array<{ title: string; time: string; date?: string; notes?: string }>;
}): Array<{ title: string; time: string; date?: string; notes?: string }> {
  if (!args.aiTimeline.length) {
    return dedupeTimelineSegments(args.fallbackTimeline);
  }
  if (!args.fallbackTimeline.length) {
    return dedupeTimelineSegments(args.aiTimeline);
  }

  const merged = dedupeTimelineSegments(args.aiTimeline);
  const existingKeys = new Set(merged.map((row) => timelineKey(row)));

  for (const row of args.fallbackTimeline) {
    const key = timelineKey(row);
    if (existingKeys.has(key)) continue;
    merged.push(row);
    existingKeys.add(key);
  }

  return dedupeTimelineSegments(merged);
}

function countTimeRangeSignals(rawText?: string): number {
  const text = (rawText || "").trim();
  if (!text) return 0;
  const pattern = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*(?:-|–|—|to)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi;
  return Array.from(text.matchAll(pattern)).length;
}

function extractionSystemPrompt(ownerIdentity?: AdminOwnerIdentity): string {
  return `You extract structured DJ booking context data for an internal workspace. Return strict JSON only. If unknown, use null or empty arrays. Prefer normalized and concise fields. Prefer signatureNameHint over senderNameHint for clientName when both exist. Extract client identity from practical sources in priority order: email header sender line, text 'To:' field/top conversation participant, Instagram top header (display name + handle), and bottom sign-off. Use semantic NLP inference over formatting: infer events from natural sentences, bullet lists, and mixed paragraphs even when structure is inconsistent. If multiple distinct event timelines are present, output timelineSegments with one row per event block. Infer event rows from named events and distinct date/time chunks. If dates are partial (for example only day numbers), map them using date-range context in the same payload. If a date range exists (for example Oct 29-31) and timeline rows mention weekdays (for example Thursday/Friday/Saturday), map each timeline row date to the matching weekday within that range. Capture per-event vibe/planning text in timelineSegments[].notes when present. Treat inquiry-header timestamps (for example 'Wed, Jan 7, 7:12 PM' or 'Feb 26, 2026, 2:30 PM (9 days ago)') as context metadata dates, not event/workspace dates, unless the client explicitly ties that date to an event the DJ would perform at. If no explicit event date is given in the message body, leave eventDate/eventDateTimestamp null. For location, extract at least city-level detail (for example 'Miami, FL' or 'Cancun, Mexico'). Do not return venue-only names without a city anchor.${ownerIdentityPrompt(ownerIdentity)}`;
}

function extractionRetrySystemPrompt(ownerIdentity?: AdminOwnerIdentity): string {
  return `You extract structured DJ booking context data for an internal workspace. Return strict JSON only. If unknown, use null or empty arrays. For text message screenshots, prefer the 'To:' contact as clientName over UI words like Delivered/Message/Read/Sent. Extract client identity from header sender lines, text To-lines/top participant names, Instagram top headers, and sign-offs. Use semantic NLP inference over formatting and infer events from natural sentences, list items, and mixed paragraphs. Treat each distinct event/date/time mention as a separate timeline row, regardless of phrasing order. If a date range exists and timeline rows mention weekdays, map each timeline row date to the matching weekday inside that range. Include per-event notes/vibes in timelineSegments[].notes when present. Treat inquiry-header timestamps as context metadata dates (not event/workspace dates) unless explicitly tied to a DJ event in the body. If no explicit event date is given in the body, leave eventDate/eventDateTimestamp null. For location, extract at least city-level detail (for example 'Miami, FL' or 'Cancun, Mexico'). Do not return venue-only names without a city anchor. Prefer signatureNameHint over senderNameHint when both exist.${ownerIdentityPrompt(ownerIdentity)}`;
}

function emailDraftSystemPrompt(): string {
  return "You write conversational, friendly, relationship-building DJ client emails in Anupya's voice. Always read the full workspace raw context and treat it as the source of truth for what has already been communicated. Then respond to the latest incoming message as the immediate action target. The output must feel like a natural continuation of an ongoing thread, not a reset. Keep tone human and warm, and adapt wording/rhythm to the client's tone plus approved prior draft examples. The email goal is to gather only the remaining details needed to provide a more accurate quote. First address requested actions and direct questions in the latest message before asking follow-ups. If the latest message requests a sample set/mix/playlist aligned to genres, explicitly confirm you will send it and reference the genres naturally. If you cannot confidently answer a client request/question from the available context, include the tag '{HUMAN INTERVENTION NEEDED}' once in the draft. If workspace status is cancelled or latest context indicates the client chose another DJ/vendor, write a supportive closeout response: acknowledge their decision positively, thank them for considering Anupya, and leave the door open if plans change. Do not continue quote collection in that case. For in_contract, execution, or completed stages, focus on operational next steps inferred from full raw context: travel/logistics planning if unresolved, playlist/vibe planning per event if unresolved, or scheduling a call if no call is evident. If the client asks to schedule a call/meeting, actively move scheduling forward by asking for concrete availability windows and confirming you can lock in a time. If the client asks what is included in pricing, clarify that Anupya personally provides DJ services (DJ performance/programming) and does not directly provide non-DJ services. Mention extra services only when specific services are explicitly mentioned in the latest context, and only reference the services named there; when you do, explain she can help coordinate those with trusted vendors (including sound setup and lighting partners) as separately scoped add-ons. If the client asks to include travel costs, explicitly confirm travel will be included in the quote and reflected in the contract. If preferCheckIn is yes, write a short check-in email that asks whether they need anything else and offers to set up a call. If quoteAlreadyShared is yes and contractReadyToSend is no, do not resend generic pricing copy; focus only on follow-up actions/questions and missing details. If contractReadyToSend is yes and availability is open, use this casual structure: start with 'Thank you for reaching out!', confirm availability, then provide a per-event quote breakdown using this exact line format for each event: 'Event: <event name>', 'Date: <date and times>', 'Billable Hours: <duration of the event>', 'Event Total: <event total cost>'. After all events, include 'Total for DJ services: <total cost>'. Then close by offering a call for questions. Keep this personable and concise. Do not reiterate old information unless the latest message explicitly asks a question or requests an action where reiteration is necessary. Avoid repetition in wording and meaning across sentences. Never copy full sentences verbatim from examples or older drafts unless the client explicitly quoted that sentence and you are directly responding to it. Do not ask for any detail that already appears in Confirmed details. Do not mention internal drafts or contracts unless contractReadyToSend is true. When referencing event dates, use the canonical event date values exactly as provided; do not infer or rewrite to a different month/day. If event_date is missing/unknown, do not state availability and explicitly ask the client to confirm the event date before quoting. Never output placeholder date tokens (for example unknown/TBD/N/A) as if they were real dates. Availability rules are strict: only mention a date conflict when dateAvailabilityStatus is unavailable_other_booking (already in contract/execution). Never mention unconfirmed inquiries or 'another inquiry not confirmed'. If dateAvailabilityStatus is available and availabilityAlreadyShared is yes, do not repeat generic availability statements unless the latest message explicitly asks about availability.";
}

function insertBeforeSignoff(draft: string, line: string): string {
  const trimmed = draft.trim();
  const signoffRegex = /\n\n(Best|Thanks|Warmly|Regards),\s*\nAnupya\s*$/i;
  if (signoffRegex.test(trimmed)) {
    return trimmed.replace(signoffRegex, `\n\n${line}\n\n$1,\nAnupya`);
  }
  return `${trimmed}\n\n${line}`;
}

function enforceEventDateRequiredInDraft(args: {
  draft: string;
  missingFields: string[];
  hasCanonicalEventDate: boolean;
}): string {
  let next = (args.draft || "").trim();
  const missingDate = args.missingFields.includes("event_date") || !args.hasCanonicalEventDate;
  if (!missingDate) return next;

  next = next
    .replace(
      /^[^\n]*(?:unknown|tbd|n\/a|that date)[^\n]*(?:tentatively open|tentatively available|currently available|currently open)[^\n]*\n?/gim,
      ""
    )
    .replace(
      /^[^\n]*(?:tentatively open|tentatively available|currently available on|currently open on)[^\n]*\n?/gim,
      ""
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!/(event date|wedding date|which date|what date|when is (?:the )?(?:event|wedding))/i.test(next)) {
    next = insertBeforeSignoff(
      next,
      "Could you confirm the event date so I can send you an accurate quote?"
    );
  }

  return next;
}

async function loadOpenAiClient(): Promise<any | null> {
  const apiKey = getAdminAiEnvConfig().apiKey;
  if (!apiKey) return null;
  try {
    const dynamicImport = new Function("specifier", "return import(specifier);") as (specifier: string) => Promise<any>;
    const openAiModule = await dynamicImport("openai");
    const OpenAI = openAiModule.default || openAiModule.OpenAI;
    if (!OpenAI) {
      return null;
    }

    return new OpenAI({ apiKey });
  } catch {
    return null;
  }
}

function extractOutputText(response: any): string {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }

  const fragments = (response?.output || [])
    .flatMap((outputItem: any) => outputItem?.content || [])
    .map((contentItem: any) => {
      if (typeof contentItem?.text === "string") {
        return contentItem.text;
      }
      if (typeof contentItem?.output_text === "string") {
        return contentItem.output_text;
      }
      return "";
    })
    .filter(Boolean);

  return fragments.join("\n");
}

async function runCodexJson<T>(args: {
  service: CodexService;
  systemPrompt: string;
  userPrompt: string;
  schemaName: string;
  schema: Record<string, unknown>;
  modelCandidates?: string[];
}): Promise<{ data: T | null; model: string; reason?: string }> {
  const preferredModel = modelForService(args.service);
  try {
    if (!codexEnabled()) {
      const configErrors = validateRuntimeConfig().errors;
      const reason = configErrors.length > 0 ? configErrors.join(" | ") : "ADMIN_ENABLE_CODEX_AI is disabled.";
      return { data: null, model: preferredModel, reason };
    }

    const client = await loadOpenAiClient();
    if (!client) {
      return { data: null, model: preferredModel, reason: "OpenAI client could not be initialized." };
    }
    const attempts: string[] = [];
    const candidates = (args.modelCandidates?.length ? args.modelCandidates : modelCandidatesForService(args.service)).filter(Boolean);
    for (const candidateModel of candidates) {
      try {
        const response = await client.responses.create({
          model: candidateModel,
          input: [
            {
              role: "system",
              content: [{ type: "input_text", text: args.systemPrompt }],
            },
            {
              role: "user",
              content: [{ type: "input_text", text: args.userPrompt }],
            },
          ],
          text: {
            format: {
              type: "json_schema",
              name: args.schemaName,
              strict: true,
              schema: args.schema,
            },
          },
        });

        const jsonText = extractOutputText(response);
        if (!jsonText.trim()) {
          attempts.push(`${candidateModel}: empty response`);
          continue;
        }

        try {
          return { data: JSON.parse(jsonText) as T, model: candidateModel };
        } catch {
          attempts.push(`${candidateModel}: invalid JSON response`);
          continue;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        attempts.push(`${candidateModel}: ${message}`);
      }
    }
    return {
      data: null,
      model: preferredModel,
      reason: attempts.join(" | "),
    };
  } catch {
    return { data: null, model: preferredModel, reason: "Unexpected error during model invocation." };
  }
}

function hasBadExtractedName(value?: string | null): boolean {
  const lowered = (value || "").trim().toLowerCase();
  if (!lowered) return true;
  const blocked = new Set(["delivered", "message", "read", "sent", "today", "yesterday"]);
  return blocked.has(lowered);
}

function rawHasExplicitDateYear(rawText?: string): boolean {
  const text = (rawText || "").trim();
  if (!text) return false;
  return (
    /\b(?:january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\s+\d{1,2}(?:st|nd|rd|th)?(?:\s*(?:,|-)\s*|\s+)20\d{2}\b/i.test(
      text
    ) ||
    /\b\d{1,2}[/-]\d{1,2}[/-](?:20\d{2}|\d{2})\b/i.test(text) ||
    /\b20\d{2}-\d{2}-\d{2}\b/.test(text)
  );
}

function coerceToCurrentYear(ts?: number): number | undefined {
  const normalized = normalizeTimestamp(ts);
  if (typeof normalized !== "number") return undefined;
  const source = new Date(normalized);
  if (Number.isNaN(source.getTime())) return undefined;
  const currentYear = new Date().getFullYear();
  return new Date(currentYear, source.getMonth(), source.getDate()).getTime();
}

function mergeExtracted(args: {
  fallback: ExtractedInquiry;
  ai: Partial<ExtractedInquiry> | null;
  signatureNameHint?: string;
  senderNameHint?: string;
  rawText?: string;
}): ExtractedInquiry {
  const { fallback, ai } = args;
  const fallbackTimeline = dedupeTimelineSegments(normalizeTimelineSegments(fallback.timelineSegments || []));
  if (!ai) {
    return {
      ...fallback,
      timelineSegments: fallbackTimeline,
      eventType: normalizeWorkspaceEventType(fallback.eventType),
      clientName: resolveClientNameFromHints({
        fallbackClientName: fallback.clientName,
        signatureNameHint: args.signatureNameHint,
        senderNameHint: args.senderNameHint,
      }),
    };
  }
  const aiTimeline = dedupeTimelineSegments(normalizeTimelineSegments(ai.timelineSegments));
  const mergedTimeline = mergeTimelineSegmentsPreferCoverage({
    aiTimeline,
    fallbackTimeline,
  });

  const merged: ExtractedInquiry = {
    clientName: typeof ai.clientName === "string" && ai.clientName.trim() ? ai.clientName.trim() : fallback.clientName,
    email: typeof ai.email === "string" && ai.email.trim() ? ai.email.trim() : fallback.email,
    phone: typeof ai.phone === "string" && ai.phone.trim() ? ai.phone.trim() : fallback.phone,
    instagramHandle: normalizeInstagramHandle(ai.instagramHandle) || fallback.instagramHandle,
    eventType: normalizeWorkspaceEventType(
      typeof ai.eventType === "string" && ai.eventType.trim() ? ai.eventType.trim() : fallback.eventType
    ),
    eventLabel:
      typeof ai.eventLabel === "string" && ai.eventLabel.trim() ? ai.eventLabel.trim() : fallback.eventLabel,
    eventDate: normalizeDateLikeText(ai.eventDate) || normalizeDateLikeText(fallback.eventDate),
    eventDateTimestamp:
      normalizeTimestamp(typeof ai.eventDateTimestamp === "number" ? ai.eventDateTimestamp : fallback.eventDateTimestamp),
    eventEndDate: normalizeDateLikeText(ai.eventEndDate) || normalizeDateLikeText(fallback.eventEndDate),
    eventEndDateTimestamp:
      normalizeTimestamp(typeof ai.eventEndDateTimestamp === "number" ? ai.eventEndDateTimestamp : fallback.eventEndDateTimestamp),
    location: normalizeLocationCandidate(ai.location) || fallback.location,
    servicesRequested: normalizeServices(ai.servicesRequested).length
      ? normalizeServices(ai.servicesRequested)
      : fallback.servicesRequested,
    guestCount: typeof ai.guestCount === "number" ? ai.guestCount : fallback.guestCount,
    duration: typeof ai.duration === "string" && ai.duration.trim() ? ai.duration.trim() : fallback.duration,
    timelineSegments: mergedTimeline,
    missingFields: Array.from(
      new Set(
        Array.isArray(ai.missingFields)
          ? ai.missingFields.filter((field) => typeof field === "string")
          : fallback.missingFields
      )
    ),
  };

  const recomputedMissing = new Set(merged.missingFields);
  const parsedEventDateTs = parseDateToTimestamp(merged.eventDate);
  if (parsedEventDateTs) {
    merged.eventDateTimestamp = parsedEventDateTs;
    merged.eventDate = timestampToIsoDate(parsedEventDateTs) || merged.eventDate;
  } else if (merged.eventDateTimestamp) {
    merged.eventDate = timestampToIsoDate(merged.eventDateTimestamp);
  }
  const parsedEventEndDateTs = parseDateToTimestamp(merged.eventEndDate);
  if (parsedEventEndDateTs) {
    merged.eventEndDateTimestamp = parsedEventEndDateTs;
    merged.eventEndDate = timestampToIsoDate(parsedEventEndDateTs) || merged.eventEndDate;
  } else if (merged.eventEndDateTimestamp) {
    merged.eventEndDate = timestampToIsoDate(merged.eventEndDateTimestamp);
  }
  if (!rawHasExplicitDateYear(args.rawText)) {
    const coercedStart = coerceToCurrentYear(merged.eventDateTimestamp);
    if (typeof coercedStart === "number") {
      merged.eventDateTimestamp = coercedStart;
      merged.eventDate = timestampToIsoDate(coercedStart) || merged.eventDate;
    }
    const coercedEnd = coerceToCurrentYear(merged.eventEndDateTimestamp);
    if (typeof coercedEnd === "number") {
      merged.eventEndDateTimestamp = coercedEnd;
      merged.eventEndDate = timestampToIsoDate(coercedEnd) || merged.eventEndDate;
    }
  }
  // Email-thread inquiries should not auto-populate Instagram handles.
  if (merged.email) {
    merged.instagramHandle = undefined;
  }
  if (!merged.email && !merged.phone && !merged.instagramHandle) recomputedMissing.add("email");
  if (!merged.eventDateTimestamp) recomputedMissing.add("event_date");
  if (!merged.location) recomputedMissing.add("location");
  if (!merged.servicesRequested.length) recomputedMissing.add("services_requested");
  if (!merged.duration && !(merged.timelineSegments || []).length) recomputedMissing.add("event_time");
  merged.missingFields = Array.from(recomputedMissing);
  merged.clientName = resolveClientNameFromHints({
    aiClientName: ai.clientName,
    fallbackClientName: merged.clientName,
    signatureNameHint: args.signatureNameHint,
    senderNameHint: args.senderNameHint,
  });

  return merged;
}

export async function extractInquiryWithCodex(args: {
  payload: InquiryProcessingPayload;
  fallback: ExtractedInquiry;
  ownerIdentity?: AdminOwnerIdentity;
}): Promise<{ extracted: ExtractedInquiry; mode: CodexMode; model: string }> {
  const serviceModel = modelForService("extract");
  const extractModelCandidates = Array.from(
    new Set(
      [
        getAdminAiEnvConfig().models.extract || "",
        "codex-5.3",
        serviceModel,
        ...fallbackModelsForService("extract"),
      ].filter(Boolean)
    )
  );

  if (!codexEnabled()) {
    const coercedFallback = await coerceExtractedLocationToCity({
      extracted: args.fallback,
    });
    return { extracted: coercedFallback, mode: "heuristic", model: serviceModel };
  }

  const aiExtractedResult = await runCodexJson<Partial<ExtractedInquiry>>({
    service: "extract",
    schemaName: "inquiry_extraction",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        clientName: { type: ["string", "null"] },
        email: { type: ["string", "null"] },
        phone: { type: ["string", "null"] },
        instagramHandle: { type: ["string", "null"] },
        eventType: { type: ["string", "null"] },
        eventLabel: { type: ["string", "null"] },
        eventDate: { type: ["string", "null"], description: "Normalize to YYYY-MM-DD when possible" },
        eventDateTimestamp: { type: ["number", "null"] },
        eventEndDate: { type: ["string", "null"], description: "If date range exists, set end date as YYYY-MM-DD when possible" },
        eventEndDateTimestamp: { type: ["number", "null"] },
        location: { type: ["string", "null"] },
        servicesRequested: { type: "array", items: { type: "string" } },
        guestCount: { type: ["number", "null"] },
        duration: { type: ["string", "null"] },
        timelineSegments: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string" },
              time: { type: "string" },
              date: { type: ["string", "null"] },
              notes: { type: ["string", "null"] },
            },
            required: ["title", "time", "date"],
          },
        },
        missingFields: { type: "array", items: { type: "string" } },
      },
      required: [
        "clientName",
        "email",
        "phone",
        "instagramHandle",
        "eventType",
        "eventLabel",
        "eventDate",
        "eventDateTimestamp",
        "eventEndDate",
        "eventEndDateTimestamp",
        "location",
        "servicesRequested",
        "guestCount",
        "duration",
        "timelineSegments",
        "missingFields",
      ],
    },
    systemPrompt: extractionSystemPrompt(args.ownerIdentity),
    userPrompt: `Extract booking context fields from this structured payload JSON:\n\n${toInquiryProcessingJson(args.payload)}`,
    modelCandidates: extractModelCandidates,
  });

  if (!aiExtractedResult.data) {
    const coercedFallback = await coerceExtractedLocationToCity({
      extracted: args.fallback,
    });
    return {
      extracted: coercedFallback,
      mode: "codex_fallback",
      model: aiExtractedResult.model || serviceModel,
    };
  }

  let merged = mergeExtracted({
    fallback: args.fallback,
    ai: aiExtractedResult.data,
    signatureNameHint: args.payload.signatureNameHint,
    senderNameHint: args.payload.senderNameHint,
    rawText: args.payload.combinedText,
  });

  // Retry extraction with stronger model when output looks weak for identity or event timeline coverage.
  const aiTimelineCount = dedupeTimelineSegments(normalizeTimelineSegments(aiExtractedResult.data.timelineSegments)).length;
  const fallbackTimelineCount = dedupeTimelineSegments(normalizeTimelineSegments(args.fallback.timelineSegments || [])).length;
  const timeRangeSignals = countTimeRangeSignals(args.payload.combinedText);
  const expectedTimelineCount = Math.max(fallbackTimelineCount, timeRangeSignals >= 2 ? 2 : 0);
  const timelineCoverageLooksWeak = expectedTimelineCount >= 2 && aiTimelineCount < expectedTimelineCount;
  const identityLooksWeak =
    hasBadExtractedName(merged.clientName) &&
    (/\bto:\s*[a-z]/i.test(args.payload.combinedText) ||
      Boolean(args.payload.signatureNameHint) ||
      Boolean(args.payload.senderNameHint));
  const shouldRetryWithStrongModel = identityLooksWeak || timelineCoverageLooksWeak;

  if (shouldRetryWithStrongModel && aiExtractedResult.model !== "codex-5.3") {
    const strongRetry = await runCodexJson<Partial<ExtractedInquiry>>({
      service: "extract",
      schemaName: "inquiry_extraction_retry",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          clientName: { type: ["string", "null"] },
          email: { type: ["string", "null"] },
          phone: { type: ["string", "null"] },
          instagramHandle: { type: ["string", "null"] },
          eventType: { type: ["string", "null"] },
          eventLabel: { type: ["string", "null"] },
          eventDate: { type: ["string", "null"], description: "Normalize to YYYY-MM-DD when possible" },
          eventDateTimestamp: { type: ["number", "null"] },
          eventEndDate: { type: ["string", "null"], description: "If date range exists, set end date as YYYY-MM-DD when possible" },
          eventEndDateTimestamp: { type: ["number", "null"] },
          location: { type: ["string", "null"] },
          servicesRequested: { type: "array", items: { type: "string" } },
          guestCount: { type: ["number", "null"] },
          duration: { type: ["string", "null"] },
          timelineSegments: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string" },
                time: { type: "string" },
                date: { type: ["string", "null"] },
                notes: { type: ["string", "null"] },
              },
              required: ["title", "time", "date"],
            },
          },
          missingFields: { type: "array", items: { type: "string" } },
        },
        required: [
          "clientName",
          "email",
          "phone",
          "instagramHandle",
          "eventType",
          "eventLabel",
          "eventDate",
          "eventDateTimestamp",
          "eventEndDate",
          "eventEndDateTimestamp",
          "location",
          "servicesRequested",
          "guestCount",
          "duration",
          "timelineSegments",
          "missingFields",
        ],
      },
      systemPrompt: extractionRetrySystemPrompt(args.ownerIdentity),
      userPrompt: `Extract booking context fields from this structured payload JSON:\n\n${toInquiryProcessingJson(args.payload)}`,
      modelCandidates: [
        getAdminAiEnvConfig().models.extract || "",
        "codex-5.3",
        "gpt-4.1-mini",
      ].filter(Boolean),
    });
    if (strongRetry.data) {
      const strongMerged = mergeExtracted({
        fallback: args.fallback,
        ai: strongRetry.data,
        signatureNameHint: args.payload.signatureNameHint,
        senderNameHint: args.payload.senderNameHint,
        rawText: args.payload.combinedText,
      });
      merged = await coerceExtractedLocationToCity({
        extracted: strongMerged,
      });
      return {
        extracted: merged,
        mode: "codex",
        model: strongRetry.model || aiExtractedResult.model || serviceModel,
      };
    }
  }

  merged = await coerceExtractedLocationToCity({
    extracted: merged,
  });
  return {
    extracted: merged,
    mode: "codex",
    model: aiExtractedResult.model || serviceModel,
  };
}

interface SemanticCandidate {
  client_id: string;
  full_name: string;
  primary_email: string;
  phone?: string;
  instagram_handle?: string;
  secondary_emails: string[];
  event_id?: string;
  event_date?: string;
  venue?: string;
  stage?: string;
  status?: string;
}

interface SemanticMatchOutput {
  match_type: "existing_event" | "existing_client" | "new_client";
  client_id: string | null;
  event_id: string | null;
  confidence: number;
  reason: string;
}

export async function semanticMatchWithCodex(args: {
  payload?: InquiryProcessingPayload;
  rawText: string;
  extracted: ExtractedInquiry;
  clients: Client[];
  events: Event[];
  fallback: MatchResult;
}): Promise<{ match: MatchResult; mode: CodexMode; model: string }> {
  const serviceModel = modelForService("match");

  if (!codexEnabled() || !args.clients.length) {
    return { match: args.fallback, mode: "heuristic", model: serviceModel };
  }

  const latestEvents = [...args.events].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 60);

  const candidates: SemanticCandidate[] = args.clients.slice(0, 80).map((client) => {
    const event = latestEvents.find((item) => item.clientId === client.id);
    return {
      client_id: client.id,
      full_name: client.fullName,
      primary_email: client.email,
      phone: client.phone,
      instagram_handle: client.instagramHandle,
      secondary_emails: client.secondaryEmails,
      event_id: event?.id,
      event_date: event?.eventDate,
      venue: event?.venue,
      stage: event?.stage,
      status: event?.status,
    };
  });

  const aiMatchResult = await runCodexJson<SemanticMatchOutput>({
    service: "match",
    schemaName: "semantic_profile_match",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        match_type: { type: "string", enum: ["existing_event", "existing_client", "new_client"] },
        client_id: { type: ["string", "null"] },
        event_id: { type: ["string", "null"] },
        confidence: { type: "number" },
        reason: { type: "string" },
      },
      required: ["match_type", "client_id", "event_id", "confidence", "reason"],
    },
    systemPrompt:
      "You perform semantic workspace matching for DJ booking operations. Prefer continuity with existing relationship context when message indicates follow-up.",
    userPrompt: `Context payload:\n${args.payload ? toInquiryProcessingJson(args.payload) : args.rawText}\n\nExtracted fields:\n${JSON.stringify(args.extracted, null, 2)}\n\nCandidates:\n${JSON.stringify(candidates, null, 2)}\n\nReturn the best match candidate or new_client.`,
  });

  if (!aiMatchResult.data) {
    return { match: args.fallback, mode: "codex_fallback", model: aiMatchResult.model || serviceModel };
  }
  const aiMatch = aiMatchResult.data;

  const confidence = Number(aiMatch.confidence || 0);
  const selectedClientId = aiMatch.client_id || undefined;
  const selectedEventId = aiMatch.event_id || undefined;

  const validClient = selectedClientId ? args.clients.some((client) => client.id === selectedClientId) : false;
  const validEvent = selectedEventId ? args.events.some((event) => event.id === selectedEventId) : false;

  if (aiMatch.match_type === "new_client") {
    if (confidence < 0.65) {
      return { match: args.fallback, mode: "codex_fallback", model: serviceModel };
    }
    return {
      match: {
        reason: "semantic_new_client",
        confidence,
      },
      mode: "codex",
      model: aiMatchResult.model || serviceModel,
    };
  }

  if (!validClient || confidence < 0.65) {
    return { match: args.fallback, mode: "codex_fallback", model: serviceModel };
  }

  return {
    match: {
      clientId: selectedClientId,
      eventId: validEvent ? selectedEventId : args.fallback.eventId,
      reason: `semantic_${aiMatch.match_type}`,
      confidence,
    },
    mode: "codex",
    model: aiMatchResult.model || serviceModel,
  };
}

export async function generateEmailDraftWithCodex(args: {
  stage: BookingStage;
  status?: string;
  clientName: string;
  extracted: ExtractedInquiry;
  missingFields: string[];
  latestContext: string;
  fullContext?: string;
  contextSummary?: string;
  hasPriorContext?: boolean;
  preferCheckIn?: boolean;
  quoteAlreadyShared?: boolean;
  approvedToneExamples?: string[];
  confirmedDetails?: {
    email?: string;
    location?: string;
    eventDate?: string;
    services?: string[];
    timeline?: string;
  };
  contractReadyToSend?: boolean;
  dateAvailabilityStatus?: "available" | "unavailable_other_booking";
  availabilityAlreadyShared?: boolean;
  fallbackDraft: string;
}): Promise<{ draft: string; mode: CodexMode; model: string }> {
  const serviceModel = modelForService("email");
  const canonicalStartTs = parseDateToTimestamp(args.extracted.eventDate) || normalizeTimestamp(args.extracted.eventDateTimestamp);
  const canonicalEndTs =
    parseDateToTimestamp(args.extracted.eventEndDate) ||
    normalizeTimestamp(args.extracted.eventEndDateTimestamp) ||
    canonicalStartTs;
  const canonicalEventDate = timestampToIsoDate(canonicalStartTs) || args.extracted.eventDate || "";
  const canonicalEventEndDate = timestampToIsoDate(canonicalEndTs) || args.extracted.eventEndDate || canonicalEventDate;
  const hasCanonicalEventDate = Boolean(canonicalStartTs || parseDateToTimestamp(canonicalEventDate));
  const effectiveMissingFields = Array.from(new Set(args.missingFields));
  if (!hasCanonicalEventDate) {
    effectiveMissingFields.push("event_date");
  }

  if (!codexEnabled()) {
    return {
      draft: enforceEventDateRequiredInDraft({
        draft: args.fallbackDraft,
        missingFields: effectiveMissingFields,
        hasCanonicalEventDate,
      }),
      mode: "heuristic",
      model: serviceModel,
    };
  }

  const toneExamples = (args.approvedToneExamples || [])
    .map((item) => (item || "").trim())
    .filter(Boolean)
    .slice(0, 4)
    .map((item, idx) => `Example ${idx + 1}:\n${item.slice(0, 1400)}`)
    .join("\n\n");

  const aiEmailResult = await runCodexJson<{ draft: string }>({
    service: "email",
    schemaName: "email_draft",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        draft: { type: "string" },
      },
      required: ["draft"],
    },
    systemPrompt: emailDraftSystemPrompt(),
    userPrompt: `Stage: ${args.stage}
Workspace status: ${args.status || "unknown"}
Client: ${args.clientName}
Extracted Context: ${JSON.stringify(args.extracted, null, 2)}
Canonical event start date (authoritative): ${canonicalEventDate || "(none)"}
Canonical event end date (authoritative): ${canonicalEventEndDate || canonicalEventDate || "(none)"}
Event date currently known: ${hasCanonicalEventDate ? "yes" : "no"}
Missing fields: ${effectiveMissingFields.join(", ") || "none"}
Has prior conversation context: ${args.hasPriorContext ? "yes" : "no"}
Prefer check-in style: ${args.preferCheckIn ? "yes" : "no"}
Quote info already shared in prior approved draft: ${args.quoteAlreadyShared ? "yes" : "no"}
Workspace context summary: ${args.contextSummary || "none"}
Contract ready to send: ${args.contractReadyToSend ? "yes" : "no"}
Date availability status for this event date: ${args.dateAvailabilityStatus || "available"}
Availability statement already shared in prior approved draft: ${args.availabilityAlreadyShared ? "yes" : "no"}
Confirmed details (do not ask for these again):
${JSON.stringify(args.confirmedDetails || {}, null, 2)}
Latest incoming context to reply to (primary response target):
${args.latestContext}

Full workspace raw context feed (authoritative, verbatim history):
${args.fullContext || args.latestContext}

Approved prior draft emails to infer voice and tone:
${toneExamples || "none"}

Generate an email draft with greeting, body, and sign-off.`,
  });

  if (!aiEmailResult.data?.draft?.trim()) {
    return {
      draft: enforceEventDateRequiredInDraft({
        draft: args.fallbackDraft,
        missingFields: effectiveMissingFields,
        hasCanonicalEventDate,
      }),
      mode: "codex_fallback",
      model: aiEmailResult.model || serviceModel,
    };
  }

  return {
    draft: enforceEventDateRequiredInDraft({
      draft: aiEmailResult.data.draft.trim(),
      missingFields: effectiveMissingFields,
      hasCanonicalEventDate,
    }),
    mode: "codex",
    model: aiEmailResult.model || serviceModel,
  };
}

export async function suggestAmendmentWithCodex(args: {
  inboundMessage: string;
  contractText: string;
  invoiceHint: string;
  fallbackSuggestion: string;
}): Promise<{ suggestion: string; mode: CodexMode; model: string }> {
  const serviceModel = modelForService("amendment");

  if (!codexEnabled()) {
    return { suggestion: args.fallbackSuggestion, mode: "heuristic", model: serviceModel };
  }

  const aiSuggestionResult = await runCodexJson<{ suggestion: string }>({
    service: "amendment",
    schemaName: "amendment_suggestion",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        suggestion: { type: "string" },
      },
      required: ["suggestion"],
    },
    systemPrompt:
      "You suggest precise contract/invoice/profile amendments for already-active DJ bookings. Preserve legal boilerplate and focus on dynamic sections, totals, dates, and logistics updates.",
    userPrompt: `Inbound message:\n${args.inboundMessage}\n\nCurrent contract excerpt:\n${args.contractText.slice(0, 2000)}\n\nCurrent invoice summary:\n${args.invoiceHint}\n\nReturn concise amendment suggestions with clear bullets for contract, invoice, and profile updates.`,
  });

  if (!aiSuggestionResult.data?.suggestion?.trim()) {
    return { suggestion: args.fallbackSuggestion, mode: "codex_fallback", model: aiSuggestionResult.model || serviceModel };
  }

  return {
    suggestion: aiSuggestionResult.data.suggestion.trim(),
    mode: "codex",
    model: aiSuggestionResult.model || serviceModel,
  };
}

export async function summarizeInquiryWithCodex(args: {
  rawText: string;
  extracted?: ExtractedInquiry;
  stage?: BookingStage;
  fallbackSummary: string;
}): Promise<{ summary: string; mode: CodexMode; model: string }> {
  const serviceModel = modelForService("summary");

  if (!codexEnabled()) {
    return { summary: args.fallbackSummary, mode: "heuristic", model: serviceModel };
  }

  const aiSummaryResult = await runCodexJson<{ summary: string }>({
    service: "summary",
    schemaName: "inquiry_summary",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: { type: "string" },
      },
      required: ["summary"],
    },
    systemPrompt:
      "You summarize DJ client workspace context for an internal relationship workspace. Use concise natural language, include stage-relevant next steps, reflect sentiment, and call out only missing info that is truly missing from the full raw context.",
    userPrompt: `Workspace stage: ${args.stage || "inquiry"}
Extracted context:
${JSON.stringify(args.extracted || {}, null, 2)}

Raw context feed:
${args.rawText}

Return a short paragraph summary.`,
  });

  if (!aiSummaryResult.data?.summary?.trim()) {
    return { summary: args.fallbackSummary, mode: "codex_fallback", model: aiSummaryResult.model || serviceModel };
  }

  return {
    summary: aiSummaryResult.data.summary.trim(),
    mode: "codex",
    model: aiSummaryResult.model || serviceModel,
  };
}

export function codexSignalLabel(mode: CodexMode): string {
  if (mode === "codex") {
    return "codex_sdk";
  }
  if (mode === "codex_fallback") {
    return "codex_failed_fallback";
  }
  return "heuristic_only";
}

export function shouldUseCodexForAdmin(): boolean {
  return codexEnabled();
}

export function codexDebugSummary(args: { extracted: ExtractedInquiry; match: MatchResult }): string {
  return `extraction_email=${safeLower(args.extracted.email)} match_reason=${args.match.reason} confidence=${args.match.confidence ?? "n/a"}`;
}

export interface ParsedContextEntry {
  actor: "client" | "me" | "unknown";
  channel: "email" | "text" | "instagram" | "call" | "unknown";
  dateLabel?: string;
  content: string;
}

export async function parseConversationContextWithCodex(args: {
  rawText: string;
  defaultChannel: "email" | "text" | "instagram" | "call" | "unknown";
  knownClientName?: string;
  ownerIdentity?: AdminOwnerIdentity;
}): Promise<{ entries: ParsedContextEntry[]; mode: CodexMode; model: string }> {
  const serviceModel = modelForService("extract");
  if (!codexEnabled()) {
    return { entries: [], mode: "heuristic", model: serviceModel };
  }

  const result = await runCodexJson<{
    entries: Array<{
      actor: "client" | "me" | "unknown";
      channel: "email" | "text" | "instagram" | "call" | "unknown";
      dateLabel: string | null;
      content: string;
    }>;
  }>({
    service: "extract",
    schemaName: "conversation_context_parse",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        entries: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              actor: { type: "string", enum: ["client", "me", "unknown"] },
              channel: { type: "string", enum: ["email", "text", "instagram", "call", "unknown"] },
              dateLabel: { type: ["string", "null"] },
              content: { type: "string" },
            },
            required: ["actor", "channel", "dateLabel", "content"],
          },
        },
      },
      required: ["entries"],
    },
    systemPrompt:
      `Parse OCR/message text into chronological communication entries. Split into one entry per message bubble/chunk. Preserve message wording exactly. Infer actor as me/client when clear; otherwise unknown. Infer channel if obvious, else unknown. Keep dateLabel as displayed text like 'Yesterday 5:29 PM' when available; otherwise null.${ownerIdentityPrompt(args.ownerIdentity)}`,
    userPrompt: `Default channel: ${args.defaultChannel}
Known client name: ${args.knownClientName || "unknown"}

Raw text:
${args.rawText}`,
  });

  if (!result.data?.entries?.length) {
    return { entries: [], mode: "codex_fallback", model: result.model || serviceModel };
  }

  const entries: ParsedContextEntry[] = result.data.entries
    .map((row) => ({
      actor: row.actor,
      channel: row.channel || args.defaultChannel,
      dateLabel: row.dateLabel || undefined,
      content: (row.content || "").trim(),
    }))
    .filter((row) => row.content);

  return {
    entries,
    mode: "codex",
    model: result.model || serviceModel,
  };
}

export async function extractWorkspaceProfileWithCodex(args: {
  rawText: string;
  existingProfile?: WorkspaceProfile;
  ownerIdentity?: AdminOwnerIdentity;
}): Promise<{ profile: Partial<WorkspaceProfile>; mode: CodexMode; model: string }> {
  const serviceModel = modelForService("extract");
  if (!codexEnabled()) {
    return { profile: {}, mode: "heuristic", model: serviceModel };
  }

  const result = await runCodexJson<{
    primaryClientName: string | null;
    primaryEmail: string | null;
    primaryPhone: string | null;
    primaryInstagramHandle: string | null;
    secondaryClientName: string | null;
    secondaryEmail: string | null;
    secondaryPhone: string | null;
    secondaryInstagramHandle: string | null;
    weddingPlannerName: string | null;
    weddingPlannerEmail: string | null;
    weddingPlannerPhone: string | null;
    weddingPlannerInstagramHandle: string | null;
    avVendorName: string | null;
    avVendorEmail: string | null;
    avVendorPhone: string | null;
    avVendorInstagramHandle: string | null;
    customFields: Array<{ key: string; value: string }>;
  }>({
    service: "extract",
    schemaName: "workspace_profile_extract",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        primaryClientName: { type: ["string", "null"] },
        primaryEmail: { type: ["string", "null"] },
        primaryPhone: { type: ["string", "null"] },
        primaryInstagramHandle: { type: ["string", "null"] },
        secondaryClientName: { type: ["string", "null"] },
        secondaryEmail: { type: ["string", "null"] },
        secondaryPhone: { type: ["string", "null"] },
        secondaryInstagramHandle: { type: ["string", "null"] },
        weddingPlannerName: { type: ["string", "null"] },
        weddingPlannerEmail: { type: ["string", "null"] },
        weddingPlannerPhone: { type: ["string", "null"] },
        weddingPlannerInstagramHandle: { type: ["string", "null"] },
        avVendorName: { type: ["string", "null"] },
        avVendorEmail: { type: ["string", "null"] },
        avVendorPhone: { type: ["string", "null"] },
        avVendorInstagramHandle: { type: ["string", "null"] },
        customFields: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              key: { type: "string" },
              value: { type: "string" },
            },
            required: ["key", "value"],
          },
        },
      },
      required: [
        "primaryClientName",
        "primaryEmail",
        "primaryPhone",
        "primaryInstagramHandle",
        "secondaryClientName",
        "secondaryEmail",
        "secondaryPhone",
        "secondaryInstagramHandle",
        "weddingPlannerName",
        "weddingPlannerEmail",
        "weddingPlannerPhone",
        "weddingPlannerInstagramHandle",
        "avVendorName",
        "avVendorEmail",
        "avVendorPhone",
        "avVendorInstagramHandle",
        "customFields",
      ],
    },
    systemPrompt:
      `Extract workspace profile entities from full booking context. Capture primary/secondary clients, planner contacts, AV vendor contacts, and concise custom key/value facts. Return strict JSON only. If unknown, use null or empty arrays.${ownerIdentityPrompt(args.ownerIdentity)}`,
    userPrompt: `Existing profile snapshot:\n${JSON.stringify(args.existingProfile || {}, null, 2)}\n\nRaw context:\n${args.rawText}`,
  });

  if (!result.data) {
    return { profile: {}, mode: "codex_fallback", model: result.model || serviceModel };
  }

  return {
    profile: normalizeWorkspaceProfilePatch(result.data),
    mode: "codex",
    model: result.model || serviceModel,
  };
}
