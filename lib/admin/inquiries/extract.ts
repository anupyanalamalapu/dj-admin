import { ExtractedInquiry } from "../types/models";
import { parseDateToTimestamp, timestampToIsoDate } from "../utils/date";
import { extractSenderFromHeader, extractSignatureName, extractToLineName, InquiryProcessingPayload } from "./payload";
import { normalizeLocationCandidate } from "./location";

const SERVICE_PATTERNS: Array<{ pattern: RegExp; service: string }> = [
  { pattern: /\bdj\b/i, service: "dj" },
  { pattern: /\bmc\b|\bemcee\b/i, service: "mc" },
  { pattern: /\blighting\b|\buplighting\b/i, service: "lighting" },
  { pattern: /\bdhol\b/i, service: "dhol" },
  { pattern: /\bbaraat\b/i, service: "baraat setup" },
];

const MONTH_TOKEN_REGEX =
  "(?:january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)";

const MONTH_DATE_PATTERN = `(${MONTH_TOKEN_REGEX})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(20\\d{2}))?`;

function bodyTextForDateInference(input: string): string {
  const parts = input.split(/\n\s*\n/).map((chunk) => chunk.trim()).filter(Boolean);
  if (parts.length <= 1) return input;
  return parts.slice(1).join("\n\n");
}

function isHeaderMetadataLine(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;

  if (/\bto me\b/i.test(trimmed)) return true;
  if (/^\s*(to|cc|bcc)\s*[:\s]/i.test(trimmed)) return true;
  if (/\(\d+\s+(?:day|days|hour|hours)\s+ago\)/i.test(trimmed)) return true;
  if (
    /^(?:mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday),?\s+[a-z]{3,9}\s+\d{1,2},?\s+\d{4}/i.test(
      trimmed
    )
  ) {
    return true;
  }
  if (/^[a-z]{3,9}\s+\d{1,2},\s*\d{4},?\s*\d{1,2}:\d{2}/i.test(trimmed)) return true;
  if (/<[^>]+>\s+[a-z]{3,9}\s+\d{1,2},\s*\d{4},?\s*\d{1,2}:\d{2}/i.test(trimmed)) return true;
  return false;
}

function lineForIndex(input: string, index: number): string {
  const start = input.lastIndexOf("\n", index) + 1;
  const nextNewLine = input.indexOf("\n", index);
  const end = nextNewLine >= 0 ? nextNewLine : input.length;
  return input.slice(start, end).trim();
}

function matchFirstSkippingHeaderMetadata(regex: RegExp, input: string): string | undefined {
  const source = regex.source;
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  const globalRegex = new RegExp(source, flags);
  for (const match of input.matchAll(globalRegex)) {
    const value = match?.[1]?.trim();
    if (!value) continue;
    const line = lineForIndex(input, match.index || 0);
    if (isHeaderMetadataLine(line)) continue;
    return value;
  }
  return undefined;
}

function normalizeMonthDayRaw(args: {
  month: string;
  day: string;
  year?: string;
}): string {
  const month = args.month.trim();
  const day = String(Number(args.day));
  const year = args.year || String(new Date().getFullYear());
  return `${month} ${day}, ${year}`;
}

function monthDayToIsoDate(args: {
  month: string;
  day: string;
  year?: string;
}): string | undefined {
  const raw = normalizeMonthDayRaw({
    month: args.month,
    day: args.day,
    year: args.year,
  });
  const ts = parseDateToTimestamp(raw);
  return timestampToIsoDate(ts);
}

function inferDateRangeFromText(input: string): { startRaw: string; endRaw: string } | undefined {
  const pattern = new RegExp(
    `\\b(${MONTH_TOKEN_REGEX})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:-|–|—|and)\\s*(?:(${MONTH_TOKEN_REGEX})\\s+)?(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(20\\d{2}))?\\b`,
    "gi"
  );
  const rangeHints = /(getting married|wedding|married|ceremony|reception|event)/i;

  let best:
    | {
        score: number;
        startRaw: string;
        endRaw: string;
      }
    | undefined;

  for (const match of input.matchAll(pattern)) {
    const firstMonth = match[1];
    const firstDay = match[2];
    const secondMonth = match[3] || firstMonth;
    const secondDay = match[4];
    const year = match[5];
    if (!firstMonth || !firstDay || !secondDay) continue;
    const line = lineForIndex(input, match.index || 0);
    if (isHeaderMetadataLine(line)) continue;

    const prefix = input.slice(Math.max(0, (match.index || 0) - 80), (match.index || 0));
    const score = rangeHints.test(prefix) ? 2 : 1;
    const candidate = {
      score,
      startRaw: normalizeMonthDayRaw({ month: firstMonth, day: firstDay, year }),
      endRaw: normalizeMonthDayRaw({ month: secondMonth, day: secondDay, year }),
    };

    if (!best || candidate.score > best.score) {
      best = candidate;
    }
  }

  return best ? { startRaw: best.startRaw, endRaw: best.endRaw } : undefined;
}

function inferDateRangeFromSlashText(input: string): { startRaw: string; endRaw: string } | undefined {
  const pattern = new RegExp(
    `\\b(${MONTH_TOKEN_REGEX})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*\\/\\s*(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(20\\d{2}))?\\b`,
    "gi"
  );
  const rangeHints = /(getting married|wedding|married|ceremony|reception|event)/i;

  let best:
    | {
        score: number;
        startRaw: string;
        endRaw: string;
      }
    | undefined;

  for (const match of input.matchAll(pattern)) {
    const month = match[1];
    const firstDay = match[2];
    const secondDay = match[3];
    const year = match[4];
    if (!month || !firstDay || !secondDay) continue;
    const line = lineForIndex(input, match.index || 0);
    if (isHeaderMetadataLine(line)) continue;

    const prefix = input.slice(Math.max(0, (match.index || 0) - 80), match.index || 0);
    const score = rangeHints.test(prefix) ? 2 : 1;
    const candidate = {
      score,
      startRaw: normalizeMonthDayRaw({ month, day: firstDay, year }),
      endRaw: normalizeMonthDayRaw({ month, day: secondDay, year }),
    };

    if (!best || candidate.score > best.score) {
      best = candidate;
    }
  }

  return best ? { startRaw: best.startRaw, endRaw: best.endRaw } : undefined;
}

function inferEventIntentDate(input: string): string | undefined {
  const pattern = new RegExp(
    `(?:getting married|wedding|event|ceremony|reception)[^\\n.]{0,140}?\\b((${MONTH_TOKEN_REGEX})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s*20\\d{2})?)\\b`,
    "i"
  );
  return matchOne(pattern, input);
}

function matchOne(regex: RegExp, input: string): string | undefined {
  const match = input.match(regex);
  return match?.[1]?.trim();
}

function matchLast(regex: RegExp, input: string): string | undefined {
  const source = regex.source;
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  const globalRegex = new RegExp(source, flags);
  let latest: string | undefined;

  for (const match of input.matchAll(globalRegex)) {
    const value = match?.[1]?.trim();
    if (value) {
      latest = value;
    }
  }

  return latest;
}

function matchLabeledValue(label: string, input: string): string | undefined {
  const regex = new RegExp(`(?:^|\\n)\\s*[•*\\-]?\\s*${label}\\s*:\\s*([^\\n]+)`, "i");
  return matchLast(regex, input);
}

function normalizeEventType(value: string | undefined, normalizedText: string): string | undefined {
  const candidate = (value || normalizedText || "").toLowerCase();
  if (candidate.includes("wedding")) {
    return "Wedding";
  }
  return "Event";
}

function inferEventLabel(input: string): string | undefined {
  const labeled = matchLabeledValue("event\\s*name", input);
  if (labeled) {
    return labeled
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  const candidates: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /\bengagement party\b/i, label: "Engagement Party" },
    { pattern: /\bwelcome party\b/i, label: "Welcome Party" },
    { pattern: /\bafter party\b/i, label: "After Party" },
  ];

  for (const entry of candidates) {
    if (entry.pattern.test(input)) {
      return entry.label;
    }
  }

  return undefined;
}

function parseServices(input: string, fullText: string): string[] {
  const found = new Set<string>();

  const labeled = matchLabeledValue("services(?:\\s+needed|\\s+requested)?", input);
  if (labeled) {
    const chunks = labeled
      .split(/,|\band\b|\+/i)
      .map((chunk) => chunk.trim())
      .filter(Boolean);

    for (const chunk of chunks) {
      const lowered = chunk.toLowerCase();
      for (const entry of SERVICE_PATTERNS) {
        if (entry.pattern.test(lowered)) {
          found.add(entry.service);
        }
      }
    }
  }

  for (const entry of SERVICE_PATTERNS) {
    if (entry.pattern.test(fullText)) {
      found.add(entry.service);
    }
  }

  return Array.from(found);
}

function inferLocationFromSentence(input: string): string | undefined {
  const directCity = input.match(/\bin\s+((?:nyc|new york city|new york|nj|new jersey|dc|washington dc))\b/i)?.[1];
  if (directCity) {
    return normalizeLocationCandidate(directCity.toUpperCase() === "NYC" ? "NYC" : directCity);
  }

  const takingOverVenue = input.match(
    /\btaking over\s+([A-Za-z][A-Za-z0-9&+.'\-\s]{2,120}?)(?=\s+(?:this|on|from|for|to|with)\b|[,.!?]|$)/i
  )?.[1];
  if (takingOverVenue) {
    return normalizeLocationCandidate(takingOverVenue);
  }

  const inClause =
    input.match(/\b(?:it['’]?s|it is|event is|wedding is)\s+in\s+([A-Za-z][A-Za-z0-9\s,.'-]{2,80}?)(?=[.!?\n]|$)/i)?.[1] ||
    input.match(/\bin\s+([A-Za-z][A-Za-z0-9\s,.'-]{2,80}?)(?=[.!?\n]|$)/i)?.[1];
  if (inClause) {
    return normalizeLocationCandidate(inClause);
  }

  const venueAfterAt = input.match(/\bat\s+([A-Za-z][A-Za-z0-9\s.'-]{2,80}?)(?=[,.!?]|$)/i)?.[1];
  if (venueAfterAt) {
    return normalizeLocationCandidate(venueAfterAt);
  }

  return undefined;
}

function normalizeClockToken(value: string, fallbackMeridiem?: "am" | "pm"): string {
  const match = value.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) {
    return value.trim();
  }
  const hour = Number(match[1]);
  const minute = match[2] || "00";
  const meridiem = (match[3] as "am" | "pm" | undefined) || fallbackMeridiem;
  return `${hour}:${minute}${meridiem || ""}`;
}

function tokenToMinutes(value: string, fallbackMeridiem?: "am" | "pm"): number | null {
  const match = value.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || "0");
  const explicitMeridiem = match[3] as "am" | "pm" | undefined;
  const meridiem = explicitMeridiem || fallbackMeridiem;

  if (minute < 0 || minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (hour === 12) hour = 0;
    if (meridiem === "pm") hour += 12;
  } else {
    // Support 24-hour values like 19:00-00:00.
    if (hour < 0 || hour > 23) return null;
  }
  return hour * 60 + minute;
}

function bestMeridiemGuess(args: {
  unknownToken: string;
  knownToken: string;
  knownMeridiem: "am" | "pm";
  unknownIsStart: boolean;
}): "am" | "pm" {
  const knownMinutes = tokenToMinutes(args.knownToken, args.knownMeridiem);
  if (knownMinutes === null) {
    return args.knownMeridiem;
  }

  const candidates: Array<{ meridiem: "am" | "pm"; diff: number }> = (["am", "pm"] as const)
    .map((meridiem) => {
      const unknownMinutes = tokenToMinutes(args.unknownToken, meridiem);
      if (unknownMinutes === null) return null;

      let diff = args.unknownIsStart ? knownMinutes - unknownMinutes : unknownMinutes - knownMinutes;
      if (diff <= 0) diff += 24 * 60;
      return { meridiem, diff };
    })
    .filter((item): item is { meridiem: "am" | "pm"; diff: number } => Boolean(item));

  const realistic = candidates.filter((candidate) => candidate.diff <= 8 * 60);
  const pool = realistic.length ? realistic : candidates;
  pool.sort((a, b) => a.diff - b.diff);
  return pool[0]?.meridiem || args.knownMeridiem;
}

function normalizeTimelineTitle(value: string): string {
  return value
    .replace(/^[\s\-–—:]+|[\s\-–—:.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

function weekdayIndex(value?: string): number | undefined {
  if (!value) return undefined;
  const lowered = value.trim().toLowerCase();
  const idx = WEEKDAY_NAMES.indexOf(lowered as (typeof WEEKDAY_NAMES)[number]);
  return idx >= 0 ? idx : undefined;
}

function resolveTimelineDate(args: {
  dayHint?: string;
  rangeStartTimestamp?: number;
  rangeEndTimestamp?: number;
}): string | undefined {
  const targetWeekday = weekdayIndex(args.dayHint);
  if (typeof targetWeekday !== "number") return undefined;
  if (typeof args.rangeStartTimestamp !== "number") return undefined;

  const start = new Date(args.rangeStartTimestamp);
  start.setHours(0, 0, 0, 0);

  const end = new Date(typeof args.rangeEndTimestamp === "number" ? args.rangeEndTimestamp : args.rangeStartTimestamp);
  end.setHours(0, 0, 0, 0);
  if (end.getTime() < start.getTime()) {
    return undefined;
  }

  // Keep this bounded to reasonable multi-day windows.
  for (let cursor = new Date(start); cursor.getTime() <= end.getTime() && cursor.getTime() - start.getTime() <= 14 * 86400000; ) {
    if (cursor.getDay() === targetWeekday) {
      return timestampToIsoDate(cursor.getTime());
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return undefined;
}

function extractInlineWeekday(value: string): string | undefined {
  const match = value.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
  return match?.[1]?.toLowerCase();
}

function stripInlineWeekday(value: string): string {
  return value
    .replace(/\bon\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi, "")
    .replace(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi, "")
    .replace(/[,:-]\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTitleKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function extractTrailingNote(value?: string): string | undefined {
  const text = (value || "").trim();
  if (!text) return undefined;
  const withoutWrapper = text.replace(/^[([{\s]+|[)\]}\s]+$/g, "").trim();
  if (!withoutWrapper) return undefined;
  return withoutWrapper;
}

function resolveDateForDayOfMonth(args: {
  dayOfMonth: number;
  rangeStartTimestamp?: number;
  rangeEndTimestamp?: number;
}): string | undefined {
  if (!Number.isFinite(args.dayOfMonth) || args.dayOfMonth < 1 || args.dayOfMonth > 31) return undefined;

  if (typeof args.rangeStartTimestamp === "number") {
    const start = new Date(args.rangeStartTimestamp);
    start.setHours(0, 0, 0, 0);
    const end = new Date(
      typeof args.rangeEndTimestamp === "number" ? args.rangeEndTimestamp : args.rangeStartTimestamp
    );
    end.setHours(0, 0, 0, 0);
    const maxWindowMs = 45 * 24 * 60 * 60000;
    for (
      let cursor = new Date(start);
      cursor.getTime() <= end.getTime() && cursor.getTime() - start.getTime() <= maxWindowMs;
      cursor.setDate(cursor.getDate() + 1)
    ) {
      if (cursor.getDate() === args.dayOfMonth) {
        return timestampToIsoDate(cursor.getTime());
      }
    }

    const fallback = new Date(start.getFullYear(), start.getMonth(), args.dayOfMonth);
    if (!Number.isNaN(fallback.getTime())) {
      return timestampToIsoDate(fallback.getTime());
    }
  }

  return undefined;
}

function inferEventTitleFromSnippet(snippet: string): string | undefined {
  const text = snippet.replace(/\s+/g, " ").trim();
  if (!text) return undefined;

  const titlePatterns: Array<{ pattern: RegExp; title: string }> = [
    { pattern: /\bsangeet\b/i, title: "Sangeet" },
    { pattern: /\breception\b/i, title: "Reception" },
    { pattern: /\bhaldi\b/i, title: "Haldi" },
    { pattern: /\bmehndi\b/i, title: "Mehndi" },
    { pattern: /\bbaraat\b/i, title: "Baraat" },
    { pattern: /\bceremony\b/i, title: "Ceremony" },
    { pattern: /\bcocktail(?:\s+hour)?\b/i, title: "Cocktail Hour" },
    { pattern: /\bwelcome\s+(?:party|dinner)\b/i, title: "Welcome Dinner" },
    { pattern: /\bafter\s*party\b/i, title: "After Party" },
  ];
  for (const entry of titlePatterns) {
    if (entry.pattern.test(text)) return entry.title;
  }

  const cleaned = text
    .replace(/\b(?:we|have|the|is|on|and|night|morning|afternoon|evening)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;
  const words = cleaned.split(" ").filter(Boolean).slice(0, 4);
  const title = words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
  return title || undefined;
}

function extractEventNotesByTitle(input: string): Map<string, string> {
  const notes = new Map<string, string>();
  const lines = input
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const cleaned = line.replace(/^[•*]+/, "").trim();
    const match = cleaned.match(/^(?:for\s+the\s+)?([A-Za-z][A-Za-z /&'-]{2,40})\s*[-:]\s*(.+)$/i);
    if (!match) continue;
    const title = inferEventTitleFromSnippet(match[1] || "");
    const note = (match[2] || "").trim();
    if (!title || !note) continue;
    const key = normalizeTitleKey(title);
    if (!key) continue;
    notes.set(key, note);
  }

  return notes;
}

function inferSegmentsFromDayMentions(args: {
  input: string;
  rangeStartTimestamp?: number;
  rangeEndTimestamp?: number;
  fallbackTime?: string;
  notesByTitle: Map<string, string>;
}): Array<{ title: string; time: string; date?: string; notes?: string }> {
  const compact = args.input.replace(/\r/g, " ").replace(/\n+/g, " ");
  const segments: Array<{ title: string; time: string; date?: string; notes?: string }> = [];

  const mentionPattern =
    /(?:^|[\s,.;!?])(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)\s+([^.!?\n]{1,80}?)(?=(?:\s+and\s+\d{1,2}(?:st|nd|rd|th)\b)|[.!?\n]|$)/gi;
  for (const match of compact.matchAll(mentionPattern)) {
    const dayOfMonth = Number(match[1]);
    if (!Number.isFinite(dayOfMonth)) continue;
    const snippet = (match[2] || "").trim();
    const title = inferEventTitleFromSnippet(snippet);
    if (!title) continue;

    const timeMatch = snippet.match(
      /(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:-|–|—|to)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i
    );
    const time = timeMatch
      ? normalizeAnyTimeRange(`${timeMatch[1]} - ${timeMatch[2]}`) || ""
      : normalizeAnyTimeRange(args.fallbackTime || "") || "";
    const date = resolveDateForDayOfMonth({
      dayOfMonth,
      rangeStartTimestamp: args.rangeStartTimestamp,
      rangeEndTimestamp: args.rangeEndTimestamp,
    });
    const notes = args.notesByTitle.get(normalizeTitleKey(title));

    if (!time && !date) continue;
    segments.push({
      title,
      time,
      date,
      notes,
    });
  }

  return segments;
}

function cleanNarrativeEventTitle(value: string): string {
  return normalizeTimelineTitle(
    value
      .replace(/^.*?\bevents?\s+(?:include|are|is)\s+/i, "")
      .replace(/^(?:events?\s*(?:include|are|is)?\s*)/i, "")
      .replace(/^(?:for|the)\s+/i, "")
      .replace(/\s+(?:at|in)\s+[A-Za-z][A-Za-z0-9&'+.\-\s]{2,80}$/i, "")
      .replace(/\s*\((?:day\s*\d+|date)\)$/i, "")
  );
}

function isValidNarrativeTitle(value: string): boolean {
  const title = normalizeTimelineTitle(value);
  if (!title) return false;
  const lowered = title.toLowerCase();
  const blocked = new Set(["from", "for", "at", "to", "and", "on", "the", "event", "events"]);
  if (blocked.has(lowered)) return false;
  if (!/[a-z]/i.test(title)) return false;
  return true;
}

function inferSegmentsFromNarrativeClauses(args: {
  input: string;
  notesByTitle: Map<string, string>;
}): Array<{ title: string; time: string; date?: string; notes?: string }> {
  const compact = args.input.replace(/\r/g, " ").replace(/\n+/g, ". ");
  const segments: Array<{ title: string; time: string; date?: string; notes?: string }> = [];
  const endBoundary = "(?=\\s*(?:,\\s*(?:and\\s+)?|;|\\.|$))";

  const titleThenDateThenTime = new RegExp(
    `([A-Za-z][A-Za-z0-9&/'+\\-\\s]{2,80}?)\\s+on\\s+${MONTH_DATE_PATTERN}\\s*(?:,|\\(|\\s)*(?:from\\s+)?(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?)\\s*(?:-|–|—|to)\\s*(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?)(?:\\))?${endBoundary}`,
    "gi"
  );
  const dateThenTitleThenTime = new RegExp(
    `(?:on\\s+)?${MONTH_DATE_PATTERN}\\s*(?:,|\\s)+(?:for\\s+)?([A-Za-z][A-Za-z0-9&/'+\\-\\s]{2,80}?)\\s*(?:,|\\(|\\s)*(?:from\\s+)?(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?)\\s*(?:-|–|—|to)\\s*(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?)(?:\\))?${endBoundary}`,
    "gi"
  );
  const dateThenParenTimeThenTitle = new RegExp(
    `(?:on\\s+)?${MONTH_DATE_PATTERN}\\s*\\(\\s*(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?)\\s*(?:-|–|—|to)\\s*(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?)\\s*\\)\\s*(?:-|–|—|for|:)\\s*([A-Za-z][A-Za-z0-9&/'+\\-\\s]{2,80}?)${endBoundary}`,
    "gi"
  );
  const dateThenTimeThenTitle = new RegExp(
    `(?:on\\s+)?${MONTH_DATE_PATTERN}\\s*(?:,|\\s)*(?:from\\s+)?(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?)\\s*(?:-|–|—|to)\\s*(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?)(?:\\s*(?:for|[-–—:,])\\s*)([A-Za-z][A-Za-z0-9&/'+\\-\\s]{2,80}?)${endBoundary}`,
    "gi"
  );

  for (const match of compact.matchAll(titleThenDateThenTime)) {
    const rawTitle = cleanNarrativeEventTitle((match[1] || "").trim());
    const title = rawTitle || inferEventTitleFromSnippet(match[1] || "");
    const time = normalizeAnyTimeRange(`${match[5] || ""} - ${match[6] || ""}`);
    const date = monthDayToIsoDate({
      month: match[2] || "",
      day: match[3] || "",
      year: match[4] || undefined,
    });
    if (!title || !time || !date || !isValidNarrativeTitle(title)) continue;
    segments.push({
      title,
      time,
      date,
      notes: args.notesByTitle.get(normalizeTitleKey(title)),
    });
  }

  for (const match of compact.matchAll(dateThenTitleThenTime)) {
    const rawTitle = cleanNarrativeEventTitle((match[4] || "").trim());
    const title = rawTitle || inferEventTitleFromSnippet(match[4] || "");
    const time = normalizeAnyTimeRange(`${match[5] || ""} - ${match[6] || ""}`);
    const date = monthDayToIsoDate({
      month: match[1] || "",
      day: match[2] || "",
      year: match[3] || undefined,
    });
    if (!title || !time || !date || !isValidNarrativeTitle(title)) continue;
    segments.push({
      title,
      time,
      date,
      notes: args.notesByTitle.get(normalizeTitleKey(title)),
    });
  }

  for (const match of compact.matchAll(dateThenParenTimeThenTitle)) {
    const rawTitle = cleanNarrativeEventTitle((match[6] || "").trim());
    const title = rawTitle || inferEventTitleFromSnippet(match[6] || "");
    const time = normalizeAnyTimeRange(`${match[4] || ""} - ${match[5] || ""}`);
    const date = monthDayToIsoDate({
      month: match[1] || "",
      day: match[2] || "",
      year: match[3] || undefined,
    });
    if (!title || !time || !date || !isValidNarrativeTitle(title)) continue;
    segments.push({
      title,
      time,
      date,
      notes: args.notesByTitle.get(normalizeTitleKey(title)),
    });
  }

  for (const match of compact.matchAll(dateThenTimeThenTitle)) {
    const rawTitle = cleanNarrativeEventTitle((match[6] || "").trim());
    const title = rawTitle || inferEventTitleFromSnippet(match[6] || "");
    const time = normalizeAnyTimeRange(`${match[4] || ""} - ${match[5] || ""}`);
    const date = monthDayToIsoDate({
      month: match[1] || "",
      day: match[2] || "",
      year: match[3] || undefined,
    });
    if (!title || !time || !date || !isValidNarrativeTitle(title)) continue;
    segments.push({
      title,
      time,
      date,
      notes: args.notesByTitle.get(normalizeTitleKey(title)),
    });
  }

  return segments;
}

function hasMeridiemToken(value: string): boolean {
  return /(am|pm)/i.test(value);
}

function normalizeAnyTimeRange(value?: string): string | undefined {
  const text = (value || "").trim();
  if (!text) return undefined;
  const match = text.match(
    /(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:-|–|—|to)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i
  );
  if (!match) return text;

  const rawStart = match[1].trim();
  const rawEnd = match[2].trim();
  const startHasMeridiem = hasMeridiemToken(rawStart);
  const endHasMeridiem = hasMeridiemToken(rawEnd);
  const startExplicit = rawStart.toLowerCase().includes("pm") ? "pm" : rawStart.toLowerCase().includes("am") ? "am" : undefined;
  const endExplicit = rawEnd.toLowerCase().includes("pm") ? "pm" : rawEnd.toLowerCase().includes("am") ? "am" : undefined;
  const startMeridiem =
    startExplicit ||
    (endExplicit
      ? bestMeridiemGuess({
          unknownToken: rawStart,
          knownToken: rawEnd,
          knownMeridiem: endExplicit,
          unknownIsStart: true,
        })
      : undefined);
  const endMeridiem =
    endExplicit ||
    (startExplicit
      ? bestMeridiemGuess({
          unknownToken: rawEnd,
          knownToken: rawStart,
          knownMeridiem: startExplicit,
          unknownIsStart: false,
        })
      : undefined);
  const resolvedStartMeridiem = startHasMeridiem ? undefined : startMeridiem;
  const resolvedEndMeridiem = endHasMeridiem ? undefined : endMeridiem;
  const start = normalizeClockToken(rawStart, resolvedStartMeridiem);
  const end = normalizeClockToken(rawEnd, resolvedEndMeridiem || resolvedStartMeridiem);
  return `${start} - ${end}`;
}

function inferDurationFromNarrative(input: string): string | undefined {
  const patterns = [
    /\bfrom\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:-|–|—|to)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/gi,
    /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:-|–|—|to)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/gi,
  ];

  for (const pattern of patterns) {
    for (const match of input.matchAll(pattern)) {
      const start = (match[1] || "").trim();
      const end = (match[2] || "").trim();
      if (!start || !end) continue;
      const normalized = normalizeAnyTimeRange(`${start} - ${end}`);
      if (!normalized) continue;
      if (!/(am|pm|:)/i.test(start) && !/(am|pm|:)/i.test(end)) continue;
      return normalized;
    }
  }

  return undefined;
}

function sanitizeLabeledDateValue(value?: string): string | undefined {
  const text = (value || "").trim();
  if (!text) return undefined;
  if (/^(unknown|n\/a|na|none|null|tbd|not\s+set|not\s+provided|unsure)$/i.test(text)) {
    return undefined;
  }
  return text;
}

function sortTimelineSegments(
  rows: Array<{ title: string; time: string; date?: string; notes?: string }>
): Array<{ title: string; time: string; date?: string; notes?: string }> {
  const startMinutes = (time: string): number => {
    const match = (time || "").match(/^(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
    if (!match) return Number.POSITIVE_INFINITY;
    const minutes = tokenToMinutes(match[1]);
    return typeof minutes === "number" ? minutes : Number.POSITIVE_INFINITY;
  };

  return [...rows].sort((a, b) => {
    const dayA = parseDateToTimestamp(a.date);
    const dayB = parseDateToTimestamp(b.date);
    const safeDayA = typeof dayA === "number" ? dayA : Number.POSITIVE_INFINITY;
    const safeDayB = typeof dayB === "number" ? dayB : Number.POSITIVE_INFINITY;
    if (safeDayA !== safeDayB) return safeDayA - safeDayB;

    const startA = startMinutes(a.time || "");
    const startB = startMinutes(b.time || "");
    if (startA !== startB) return startA - startB;

    return (a.title || "").localeCompare(b.title || "");
  });
}

function looksLikeClockRange(rawStart: string, rawEnd: string): boolean {
  const hasMeridiem = hasMeridiemToken(rawStart) || hasMeridiemToken(rawEnd);
  const hasMinutes = /:\d{2}/.test(rawStart) || /:\d{2}/.test(rawEnd);
  if (hasMeridiem || hasMinutes) return true;
  return false;
}

function parseTimelineSegments(
  input: string,
  args?: { rangeStartTimestamp?: number; rangeEndTimestamp?: number }
): Array<{ title: string; time: string; date?: string; notes?: string }> {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const segmentsMap = new Map<string, { title: string; time: string; date?: string; notes?: string }>();
  let activeWeekday: string | undefined;

  for (const line of lines) {
    const cleaned = line.replace(/^[•*]+/, "").trim();
    const dayHeader = cleaned.match(/^(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s*:?$/i)?.[1];
    if (dayHeader) {
      activeWeekday = dayHeader.toLowerCase();
      continue;
    }

    const timeFirstMatch = cleaned.match(
      /^(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:-|–|—|to)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s+(.+?)(?:\s*(\([^)]*\)|\[[^\]]*\]))?$/i
    );
    const titleFirstMatch = cleaned.match(
      /^(.+?)\s*(?:-|–|—)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:-|–|—|to)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)(?:\s*(\([^)]*\)|\[[^\]]*\]))?(?:\s*(?:[,.;!?].*))?$/i
    );
    const weekdayPrefixedMatch = cleaned.match(
      /^(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+(.+?)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:-|–|—|to)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)(?:\s*(\([^)]*\)|\[[^\]]*\]))?(?:\s*(?:[,.;!?].*))?$/i
    );
    const activeDayNoDashMatch = activeWeekday
      ? cleaned.match(
          /^(.+?)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:-|–|—|to)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)(?:\s*(\([^)]*\)|\[[^\]]*\]))?(?:\s*(?:[,.;!?].*))?$/i
        )
      : null;
    if (!timeFirstMatch && !titleFirstMatch && !weekdayPrefixedMatch && !activeDayNoDashMatch) continue;

    const rawStart = (
      timeFirstMatch?.[1] ||
      titleFirstMatch?.[2] ||
      weekdayPrefixedMatch?.[3] ||
      activeDayNoDashMatch?.[2] ||
      ""
    ).trim();
    const rawEnd = (
      timeFirstMatch?.[2] ||
      titleFirstMatch?.[3] ||
      weekdayPrefixedMatch?.[4] ||
      activeDayNoDashMatch?.[3] ||
      ""
    ).trim();
    if (!rawStart || !rawEnd) continue;
    if (!looksLikeClockRange(rawStart, rawEnd)) continue;

    let titleCandidate = timeFirstMatch
      ? (timeFirstMatch[3] || "").trim()
      : titleFirstMatch
        ? (titleFirstMatch[1] || "").trim()
        : weekdayPrefixedMatch
          ? (weekdayPrefixedMatch[2] || "").trim()
          : (activeDayNoDashMatch?.[1] || "").trim();
    titleCandidate = titleCandidate.replace(/^[\-–—:,.\s]+|[\-–—:,.\s]+$/g, "");
    const inlineWeekday = extractInlineWeekday(titleCandidate);
    const title = normalizeTimelineTitle(stripInlineWeekday(titleCandidate));
    const loweredTitle = title.toLowerCase();
    if (["time", "hours", "hour", "date"].includes(loweredTitle)) continue;
    if (title.length > 80) continue;
    if (/[?!]/.test(title)) continue;
    if (!title || !/[A-Za-z]/.test(title)) continue;

    const startHasMeridiem = hasMeridiemToken(rawStart);
    const endHasMeridiem = hasMeridiemToken(rawEnd);
    const startExplicit = rawStart.toLowerCase().includes("pm") ? "pm" : rawStart.toLowerCase().includes("am") ? "am" : undefined;
    const endExplicit = rawEnd.toLowerCase().includes("pm") ? "pm" : rawEnd.toLowerCase().includes("am") ? "am" : undefined;

    const startMeridiem =
      startExplicit ||
      (endExplicit
        ? bestMeridiemGuess({
            unknownToken: rawStart,
            knownToken: rawEnd,
            knownMeridiem: endExplicit,
            unknownIsStart: true,
          })
        : undefined);
    const endMeridiem =
      endExplicit ||
      (startExplicit
        ? bestMeridiemGuess({
            unknownToken: rawEnd,
            knownToken: rawStart,
            knownMeridiem: startExplicit,
            unknownIsStart: false,
          })
        : undefined);

    const resolvedStartMeridiem = startHasMeridiem ? undefined : startMeridiem;
    const resolvedEndMeridiem = endHasMeridiem ? undefined : endMeridiem;
    const start = normalizeClockToken(rawStart, resolvedStartMeridiem);
    const end = normalizeClockToken(rawEnd, resolvedEndMeridiem || resolvedStartMeridiem);
    const time = `${start} - ${end}`;
    const dayHint = weekdayPrefixedMatch?.[1]?.toLowerCase() || inlineWeekday || activeWeekday;
    const resolvedDate = resolveTimelineDate({
      dayHint,
      rangeStartTimestamp: args?.rangeStartTimestamp,
      rangeEndTimestamp: args?.rangeEndTimestamp,
    });
    const rawNote =
      timeFirstMatch?.[4] ||
      titleFirstMatch?.[4] ||
      weekdayPrefixedMatch?.[5] ||
      activeDayNoDashMatch?.[4];
    const notes = extractTrailingNote(rawNote);

    const key = `${normalizeTimelineTitle(title).toLowerCase()}|${time.toLowerCase().replace(/\s+/g, "")}|${resolvedDate || ""}`;
    if (segmentsMap.has(key)) {
      segmentsMap.delete(key);
    }
    segmentsMap.set(key, { title, time, date: resolvedDate, notes });
  }

  return Array.from(segmentsMap.values());
}

function isLikelyPersonName(value?: string): boolean {
  if (!value) return false;
  const normalized = value.trim();
  if (!normalized || !/[A-Za-z]/.test(normalized)) return false;
  const lowered = normalized.toLowerCase();
  const blocked = ["gmail", "yahoo", "outlook", "event", "wedding", "hours ago", "to me", "delivered", "read", "sent"];
  const blockedStandalone = new Set([
    "hi",
    "hello",
    "hey",
    "thanks",
    "thank",
    "best",
    "regards",
    "sincerely",
    "warmly",
    "cheers",
    "delivered",
    "read",
    "sent",
    "message",
  ]);
  if (blocked.some((term) => lowered.includes(term))) return false;
  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length < 1 || parts.length > 4) return false;
  if (parts.length === 1) {
    const part = parts[0];
    if (blockedStandalone.has(part.toLowerCase())) return false;
    return /^[A-Za-z][A-Za-z.'-]{1,29}$/.test(part);
  }
  return parts.every((part) => /^[A-Za-z][A-Za-z.'-]*$/.test(part));
}

function cleanName(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
  return normalized || undefined;
}

function selectClientName(args: {
  signatureNameHint?: string;
  senderNameHint?: string;
  explicitName?: string;
  labeledName?: string;
  toLineName?: string;
  instagramHeaderNameHint?: string;
}): string | undefined {
  const candidates = [
    args.explicitName,
    args.labeledName,
    args.toLineName,
    args.signatureNameHint,
    args.instagramHeaderNameHint,
    args.senderNameHint,
  ]
    .map(cleanName)
    .filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (isLikelyPersonName(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function extractInstagramHeaderHints(input: string): { nameHint?: string; handleHint?: string } {
  const lines = input
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 14);

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] || "";
    const token = raw.replace(/^@+/, "").replace(/\.{2,}$/g, "").trim().toLowerCase();
    if (!token) continue;
    if (!/^[a-z0-9._]{2,30}$/.test(token)) continue;
    if (token.includes("@")) continue;
    if (!/[a-z]/.test(token)) continue;
    if (!/[_\.]/.test(token)) continue;

    const handleHint = `@${token}`;
    const nameLine = (lines[i - 1] || "").replace(/[^A-Za-z\s.'-]/g, " ").replace(/\s+/g, " ").trim();
    const nameHint = isLikelyPersonName(nameLine) ? cleanName(nameLine) : undefined;
    return { nameHint, handleHint };
  }

  return {};
}

function extractInstagramHandle(
  input: string,
  options?: {
    allowLooseMention?: boolean;
  }
): string | undefined {
  const explicitHandle = matchOne(
    /(?:instagram|insta|ig)\s*(?:handle|id|username)?\s*[:\-]?\s*@?([a-z0-9._]{2,30})\b/i,
    input
  );
  const looseHandle = options?.allowLooseMention
    ? matchOne(/(?:^|[\s([{>])@([a-z0-9._]{2,30})\b/i, input)
    : undefined;
  const directHandle = explicitHandle || looseHandle;

  if (!directHandle) {
    return undefined;
  }

  const normalized = directHandle.replace(/^@+/, "").trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes("@")) return undefined;
  if (normalized.includes("gmail") || normalized.includes("yahoo") || normalized.includes("outlook")) {
    return undefined;
  }
  if (/\.(com|net|org|edu|gov|io|co)$/i.test(normalized)) return undefined;
  if (!/^[a-z0-9._]{2,30}$/.test(normalized)) return undefined;
  return `@${normalized}`;
}

type ExtractionHints = Pick<InquiryProcessingPayload, "senderEmailHint" | "senderNameHint" | "signatureNameHint">;

export function extractInquiryFromText(text: string, hints?: Partial<ExtractionHints>): ExtractedInquiry {
  const normalized = text.replace(/\r/g, "");
  const lowered = normalized.toLowerCase();
  const bodyForDate = bodyTextForDateInference(normalized);

  const headerHints = extractSenderFromHeader(normalized);
  const signatureNameHint = hints?.signatureNameHint || extractSignatureName(normalized);
  const senderNameHint = hints?.senderNameHint || headerHints.senderNameHint;
  const instagramHeaderHints = extractInstagramHeaderHints(normalized);

  const email = hints?.senderEmailHint || headerHints.senderEmailHint || matchOne(/\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i, normalized);
  const phone = matchOne(/\b(\+?\d[\d\s().-]{8,}\d)\b/, normalized);
  const instagramHandleRaw =
    instagramHeaderHints.handleHint ||
    extractInstagramHandle(normalized, {
      // For email-thread inquiries, avoid hallucinating Instagram handles from generic @mentions.
      allowLooseMention: !email,
    });
  const instagramHandle = email ? undefined : instagramHandleRaw;

  const explicitName = matchOne(
    /(?:my name is|i am|this is)\s+([A-Za-z][A-Za-z.'-]{1,30}(?:\s+[A-Za-z][A-Za-z.'-]{1,30}){0,3})(?=\s+(?:and|but)\b|[\n,.!?]|$)/i,
    normalized
  );
  const labeledName = matchOne(/name\s*[:\-]\s*([A-Za-z][A-Za-z\s.'&-]{1,40})/i, normalized);
  const toLineName = matchOne(
    /(?:^|\n)\s*to:\s*([A-Za-z][A-Za-z.'-]{1,30}(?:\s+[A-Za-z][A-Za-z.'-]{1,30}){0,3})(?=\s+(?:share|message|delivered|today|yesterday)\b|[\n,.!?]|$)/i,
    normalized
  );
  const toLineNameHint = extractToLineName(normalized);
  const clientName = selectClientName({
    signatureNameHint,
    senderNameHint,
    explicitName,
    labeledName,
    toLineName: toLineNameHint || toLineName,
    instagramHeaderNameHint: instagramHeaderHints.nameHint,
  });

  const labeledEventType = matchLabeledValue("event\\s*type", normalized);
  const eventType = normalizeEventType(labeledEventType, lowered);

  const eventLabel = inferEventLabel(normalized) || inferEventLabel(bodyForDate);
  const labeledDate = sanitizeLabeledDateValue(matchLabeledValue("date", normalized));
  const labeledRange = labeledDate ? inferDateRangeFromText(labeledDate) || inferDateRangeFromSlashText(labeledDate) : undefined;
  const bodyRange = inferDateRangeFromText(bodyForDate) || inferDateRangeFromSlashText(bodyForDate);
  const fullRange = inferDateRangeFromText(normalized) || inferDateRangeFromSlashText(normalized);
  const eventRange = labeledRange || bodyRange || fullRange;
  const eventIntentDate = inferEventIntentDate(bodyForDate);
  const bodyMonthDate = matchFirstSkippingHeaderMetadata(
    new RegExp(`\\b(${MONTH_TOKEN_REGEX}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s*20\\d{2})?)\\b`, "i"),
    bodyForDate
  );

  const rawDate =
    eventRange?.startRaw ||
    labeledDate ||
    eventIntentDate ||
    bodyMonthDate ||
    matchFirstSkippingHeaderMetadata(
      new RegExp(`\\b(${MONTH_TOKEN_REGEX}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s*20\\d{2})?)\\b`, "i"),
      normalized
    ) ||
    matchFirstSkippingHeaderMetadata(/\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/, bodyForDate) ||
    matchFirstSkippingHeaderMetadata(/\b(20\d{2}-\d{2}-\d{2})\b/, bodyForDate) ||
    matchFirstSkippingHeaderMetadata(/\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/, normalized) ||
    matchFirstSkippingHeaderMetadata(/\b(20\d{2}-\d{2}-\d{2})\b/, normalized);

  const eventDateTimestamp = parseDateToTimestamp(rawDate);
  const eventDate = timestampToIsoDate(eventDateTimestamp) || rawDate;
  const eventEndDateRaw = eventRange?.endRaw;
  const eventEndDateTimestamp = parseDateToTimestamp(eventEndDateRaw);
  const eventEndDate = timestampToIsoDate(eventEndDateTimestamp) || eventEndDateRaw;

  const location =
    normalizeLocationCandidate(matchLabeledValue("location", normalized)) ||
    normalizeLocationCandidate(matchLabeledValue("venue", normalized)) ||
    normalizeLocationCandidate(matchOne(/(?:\bvenue\b|\blocation\b)\s*[:\-]\s*([^\n]{3,120})/i, normalized)) ||
    inferLocationFromSentence(normalized);

  const guestCountStr =
    matchLabeledValue("estimated\\s+guest\\s+count", normalized) ||
    matchOne(/(?:guest count|guests?)\s*[:\-]?\s*~?\s*(\d{2,4})/i, normalized);
  const guestCount = guestCountStr ? Number.parseInt(guestCountStr.replace(/[^\d]/g, ""), 10) : undefined;

  const explicitDuration =
    matchLabeledValue("time", normalized) ||
    matchLast(
      /(?:\btimes?\b)\s*(?:are|is)?\s*[:\-]?\s*(\d{1,2}:?\d{0,2}\s*(?:am|pm)\s*(?:-|to)\s*\d{1,2}:?\d{0,2}\s*(?:am|pm))/i,
      normalized
    ) ||
    matchLast(
      /(?:\bfrom\b|\baround\b)?\s*(\d{1,2}:\d{2}\s*(?:am|pm)?\s*(?:-|to)\s*\d{1,2}:\d{2}\s*(?:am|pm)?)/i,
      normalized
    ) ||
    matchLast(/(?:from|time)\s*[:\-]?\s*(\d{1,2}:?\d{0,2}\s*(?:am|pm)\s*(?:-|to)\s*\d{1,2}:?\d{0,2}\s*(?:am|pm))/i, normalized) ||
    matchLast(/(\d{1,2}:\d{2}\s*(?:am|pm)\s*-\s*\d{1,2}:\d{2}\s*(?:am|pm))/i, normalized) ||
    inferDurationFromNarrative(normalized);

  const notesByTitle = extractEventNotesByTitle(normalized);
  const parsedTimeline = parseTimelineSegments(normalized, {
    rangeStartTimestamp: eventDateTimestamp,
    rangeEndTimestamp: eventEndDateTimestamp,
  }).map((segment) => ({
    ...segment,
    notes: segment.notes || notesByTitle.get(normalizeTitleKey(segment.title)),
  }));
  const dayMentionSegments = inferSegmentsFromDayMentions({
    input: normalized,
    rangeStartTimestamp: eventDateTimestamp,
    rangeEndTimestamp: eventEndDateTimestamp,
    fallbackTime: explicitDuration,
    notesByTitle,
  });
  const narrativeSegments = inferSegmentsFromNarrativeClauses({
    input: normalized,
    notesByTitle,
  });
  const mergedTimelineMap = new Map<string, { title: string; time: string; date?: string; notes?: string }>();
  for (const segment of [...parsedTimeline, ...dayMentionSegments, ...narrativeSegments]) {
    if (!segment.title || !segment.time) continue;
    const normalizedTitle = normalizeTitleKey(segment.title);
    const normalizedTime = segment.time.toLowerCase().replace(/\s+/g, "");
    const normalizedDate = (segment.date || "").trim();
    const key = `${normalizedTitle}|${normalizedDate}|${normalizedTime}`;

    // If we already have a dated segment for the same title/time, skip undated duplicates
    // coming from loose day-of-month mention inference.
    if (!normalizedDate) {
      const datedEntry = Array.from(mergedTimelineMap.entries()).find(([, item]) => {
        const existingDate = (item.date || "").trim();
        if (!existingDate) return false;
        return (
          normalizeTitleKey(item.title) === normalizedTitle &&
          item.time.toLowerCase().replace(/\s+/g, "") === normalizedTime
        );
      });
      if (datedEntry) {
        const [datedKey, datedItem] = datedEntry;
        mergedTimelineMap.set(datedKey, {
          ...datedItem,
          notes: datedItem.notes || segment.notes,
        });
        continue;
      }
    }

    const existing = mergedTimelineMap.get(key);
    if (!existing) {
      mergedTimelineMap.set(key, segment);
      continue;
    }
    mergedTimelineMap.set(key, {
      ...existing,
      date: existing.date || segment.date,
      notes: existing.notes || segment.notes,
    });
  }
  const timelineSegments = sortTimelineSegments(Array.from(mergedTimelineMap.values()));
  const timelineDuration = timelineSegments.length
    ? timelineSegments.map((segment) => segment.time).join("; ")
    : undefined;
  const duration = explicitDuration || timelineDuration;

  const servicesRequested = parseServices(normalized, lowered);

  const missingFields: string[] = [];
  if (!email && !phone && !instagramHandle) missingFields.push("email");
  if (!eventDateTimestamp) missingFields.push("event_date");
  if (!location) missingFields.push("location");
  if (!servicesRequested.length) missingFields.push("services_requested");
  if (!duration && !timelineSegments.length) missingFields.push("event_time");

  return {
    clientName,
    email,
    phone,
    instagramHandle,
    eventType,
    eventLabel,
    eventDate,
    eventDateTimestamp,
    eventEndDate,
    eventEndDateTimestamp,
    location,
    servicesRequested,
    guestCount,
    duration,
    timelineSegments,
    missingFields,
  };
}
