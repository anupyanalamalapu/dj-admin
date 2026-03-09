function stripOrdinals(input: string): string {
  return input.replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, "$1");
}

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function parseIsoLocalDate(input: string): Date | null {
  const iso = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!iso) return null;
  const year = Number(iso[1]);
  const month = Number(iso[2]);
  const day = Number(iso[3]);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function parseMonthDayYearLike(input: string): Date | null {
  const cleaned = normalizeWhitespace(stripOrdinals(input));
  const isoDate = parseIsoLocalDate(cleaned);
  if (isoDate) {
    return isoDate;
  }

  const monthDay = cleaned.match(
    /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\s+(\d{1,2})(?:,?\s*(\d{4}))?\b/i
  );
  if (monthDay) {
    const monthToken = monthDay[1].toLowerCase();
    const monthMap: Record<string, number> = {
      jan: 0,
      january: 0,
      feb: 1,
      february: 1,
      mar: 2,
      march: 2,
      apr: 3,
      april: 3,
      may: 4,
      jun: 5,
      june: 5,
      jul: 6,
      july: 6,
      aug: 7,
      august: 7,
      sep: 8,
      sept: 8,
      september: 8,
      oct: 9,
      october: 9,
      nov: 10,
      november: 10,
      dec: 11,
      december: 11,
    };
    const monthIndex = monthMap[monthToken];
    const day = Number(monthDay[2]);
    const year = monthDay[3] ? Number(monthDay[3]) : new Date().getFullYear();
    const date = new Date(year, monthIndex, day);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  const mdy = cleaned.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (mdy) {
    const month = Number(mdy[1]);
    const day = Number(mdy[2]);
    const yearRaw = mdy[3] ? Number(mdy[3]) : new Date().getFullYear();
    const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
    const date = new Date(year, month - 1, day);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  const hasExplicitYear =
    /\b(?:19|20)\d{2}\b/.test(cleaned) || /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/.test(cleaned);
  if (hasExplicitYear) {
    const direct = new Date(cleaned);
    if (!Number.isNaN(direct.getTime())) {
      return direct;
    }
  }

  return null;
}

export function parseDateToTimestamp(input?: string): number | undefined {
  if (!input) {
    return undefined;
  }

  const parsed = parseMonthDayYearLike(input);
  if (!parsed) {
    return undefined;
  }

  return parsed.getTime();
}

export function normalizeTimestamp(value?: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  // Normalize unix seconds (10-digit epoch) to milliseconds.
  if (Math.abs(value) > 0 && Math.abs(value) < 1e11) {
    return Math.round(value * 1000);
  }
  return Math.round(value);
}

export function timestampToIsoDate(value?: number): string | undefined {
  const normalized = normalizeTimestamp(value);
  if (typeof normalized !== "number") {
    return undefined;
  }

  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatDateLong(args: {
  timestamp?: number;
  isoDate?: string;
  fallback?: string;
}): string {
  const { timestamp, isoDate, fallback = "-" } = args;

  let date: Date | null = null;

  if (isoDate) {
    const parsedIso = parseIsoLocalDate(isoDate);
    if (parsedIso) {
      date = parsedIso;
    } else {
      const fromIso = new Date(isoDate);
      if (!Number.isNaN(fromIso.getTime())) {
        date = fromIso;
      }
    }
  }

  if (!date) {
    const normalizedTimestamp = normalizeTimestamp(timestamp);
    if (typeof normalizedTimestamp === "number") {
      const fromTs = new Date(normalizedTimestamp);
      if (!Number.isNaN(fromTs.getTime())) {
        date = fromTs;
      }
    }
  }

  if (!date) {
    return fallback;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function formatDateShort(args: {
  timestamp?: number;
  isoDate?: string;
  fallback?: string;
}): string {
  const { timestamp, isoDate, fallback = "-" } = args;

  let date: Date | null = null;

  if (isoDate) {
    const parsedIso = parseIsoLocalDate(isoDate);
    if (parsedIso) {
      date = parsedIso;
    } else {
      const fromIso = new Date(isoDate);
      if (!Number.isNaN(fromIso.getTime())) {
        date = fromIso;
      }
    }
  }

  if (!date) {
    const normalizedTimestamp = normalizeTimestamp(timestamp);
    if (typeof normalizedTimestamp === "number") {
      const fromTs = new Date(normalizedTimestamp);
      if (!Number.isNaN(fromTs.getTime())) {
        date = fromTs;
      }
    }
  }

  if (!date) {
    return fallback;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function formatDateTime(value: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

function formatDateTimeShort(value: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

function formatTime(value: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

export function formatDateTimeRange(args: {
  startTimestamp?: number;
  endTimestamp?: number;
  fallback?: string;
}): string {
  const fallback = args.fallback || "-";
  const startTs = normalizeTimestamp(args.startTimestamp);
  const endTs = normalizeTimestamp(args.endTimestamp);
  if (typeof startTs !== "number" || typeof endTs !== "number") {
    return fallback;
  }

  const start = new Date(startTs);
  const end = new Date(endTs);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return fallback;
  }

  const sameDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();

  if (sameDay) {
    return `${new Intl.DateTimeFormat("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(start)}, ${formatTime(start)} - ${formatTime(end)}`;
  }

  return `${formatDateTime(start)} -> ${formatDateTime(end)}`;
}

export function formatDateTimeRangeCompact(args: {
  startTimestamp?: number;
  endTimestamp?: number;
  fallback?: string;
}): string {
  const fallback = args.fallback || "-";
  if (typeof args.startTimestamp !== "number" || typeof args.endTimestamp !== "number") {
    return fallback;
  }

  const start = new Date(args.startTimestamp);
  const end = new Date(args.endTimestamp);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return fallback;
  }

  const sameDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();

  if (sameDay) {
    return `${new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(start)}, ${formatTime(start)} - ${formatTime(end)}`;
  }

  return `${formatDateTimeShort(start)} -> ${formatDateTimeShort(end)}`;
}
