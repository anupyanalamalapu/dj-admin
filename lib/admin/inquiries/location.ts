import type { ExtractedInquiry } from "../types/models";

const LOCATION_BLOCKED_PATTERNS: RegExp[] = [
  /\bthanks\b/i,
  /\badvance\b/i,
  /\bpricing\b/i,
  /\bincluded\b/i,
  /\btimeline\b/i,
  /\bcall\b/i,
  /\bchat\b/i,
  /that night/i,
  /hours ago/i,
  /\bto me\b/i,
  /wedding is/i,
];

const LOCATION_VENUE_WORDS = new Set([
  "hotel",
  "resort",
  "hall",
  "ballroom",
  "banquet",
  "center",
  "centre",
  "club",
  "palace",
  "chateau",
  "castle",
  "gardens",
  "garden",
  "vineyard",
  "winery",
  "restaurant",
  "marina",
  "boat",
  "venue",
  "park",
  "lounge",
  "bar",
  "cafe",
]);

const CITY_ALIASES: Record<string, string> = {
  nyc: "NYC",
  "new york city": "New York City",
  dc: "DC",
  "washington dc": "Washington, DC",
  sf: "San Francisco",
  la: "Los Angeles",
};

const STATE_OR_COUNTRY_ONLY = new Set([
  "nj",
  "new jersey",
  "ny",
  "california",
  "ca",
  "florida",
  "fl",
  "texas",
  "tx",
  "usa",
  "u.s.a",
  "united states",
  "us",
  "u.s",
  "india",
  "mexico",
  "canada",
]);

const US_STATE_TO_CODE: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "district of columbia": "DC",
};

const LOCATION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const LOCATION_API_COOLDOWN_MS = 2 * 60 * 1000;
const LOCATION_API_TIMEOUT_MS = 1200;
const locationCache = new Map<string, { location?: string; verified: boolean; expiresAt: number }>();
let apiCooldownUntil = 0;
const DEFAULT_FALLBACK_CITY = "NYC";

function locationApiEnabled(): boolean {
  if (process.env.ADMIN_ENABLE_LOCATION_API === "true") return true;
  if (process.env.ADMIN_ENABLE_LOCATION_API === "false") return false;
  if (process.env.NODE_TEST_CONTEXT) return false;
  return true;
}

function capitalizeToken(token: string): string {
  if (!token) return "";
  if (/^[A-Z]{2,3}$/.test(token)) return token;
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

function toDisplayCase(input: string): string {
  return input
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => capitalizeToken(token))
    .join(" ");
}

function firstLocationPart(input: string): string {
  return input.split(",")[0]?.trim() || input.trim();
}

function tokenLooksVenueWord(token: string): boolean {
  return LOCATION_VENUE_WORDS.has(token.toLowerCase());
}

function locationLooksVenueLike(input: string): boolean {
  const words = input
    .split(/[\s,+/()-]+/)
    .map((word) => word.trim())
    .filter(Boolean);
  return words.some((word) => tokenLooksVenueWord(word));
}

function locationHasExplicitRegionHint(input: string): boolean {
  const normalized = input.trim();
  if (!normalized.includes(",")) return false;
  const regionPart = normalized
    .split(",")
    .slice(1)
    .join(",")
    .trim();
  if (!regionPart) return false;
  const lowerRegion = regionPart.toLowerCase().replace(/[.]/g, "").trim();
  if (!lowerRegion) return false;
  if (STATE_OR_COUNTRY_ONLY.has(lowerRegion)) return true;
  if (/^[A-Z]{2}$/.test(regionPart)) return true;
  if (/[A-Za-z]{2,}/.test(regionPart)) return true;
  return false;
}

function locationIsStateOrCountryOnly(input: string): boolean {
  const normalized = input.toLowerCase().replace(/[.]/g, "").trim();
  return STATE_OR_COUNTRY_ONLY.has(normalized);
}

function locationLooksLikeCityToken(input: string): boolean {
  const normalized = input.trim();
  if (!normalized) return false;
  if (/\d/.test(normalized)) return false;
  if (locationIsStateOrCountryOnly(normalized)) return false;
  const words = normalized.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 4) return false;
  if (words[0]?.toLowerCase() === "the") return false;
  if (!words.every((word) => /^[A-Za-z][A-Za-z.'-]*$/.test(word))) return false;
  if (words.some((word) => tokenLooksVenueWord(word))) return false;
  return true;
}

function canonicalAlias(input: string): string | undefined {
  const key = input.toLowerCase().trim();
  return CITY_ALIASES[key];
}

function canonicalRegion(region?: string, countryCode?: string): string | undefined {
  const raw = (region || "").trim();
  if (!raw) return undefined;
  if ((countryCode || "").toLowerCase() === "us") {
    const stateCode = US_STATE_TO_CODE[raw.toLowerCase()];
    if (stateCode) return stateCode;
  }
  return toDisplayCase(raw);
}

function isUsCountryCode(value?: string): boolean {
  return (value || "").toLowerCase() === "us";
}

function formatCityResult(args: {
  city: string;
  region?: string;
  country?: string;
  countryCode?: string;
}): string | undefined {
  const cityRaw = args.city.trim();
  if (!cityRaw || !locationLooksLikeCityToken(cityRaw)) return undefined;
  const city = toDisplayCase(cityRaw);
  const region = canonicalRegion(args.region, args.countryCode);
  if (region) return `${city}, ${region}`;
  if (args.country && !isUsCountryCode(args.countryCode)) return `${city}, ${toDisplayCase(args.country)}`;
  return city;
}

function cityFromNominatim(payload: unknown): string | undefined {
  const first = Array.isArray(payload) ? payload[0] : undefined;
  if (!first || typeof first !== "object") return undefined;
  const address = (first as Record<string, unknown>).address as Record<string, unknown> | undefined;
  if (!address) return undefined;
  const city =
    (typeof address.city === "string" ? address.city : undefined) ||
    (typeof address.town === "string" ? address.town : undefined) ||
    (typeof address.village === "string" ? address.village : undefined) ||
    (typeof address.municipality === "string" ? address.municipality : undefined);
  const region =
    (typeof address.state === "string" ? address.state : undefined) ||
    (typeof address.state_district === "string" ? address.state_district : undefined);
  const country = typeof address.country === "string" ? address.country : undefined;
  const countryCode = typeof address.country_code === "string" ? address.country_code : undefined;
  if (!city) return undefined;
  return formatCityResult({
    city,
    region,
    country,
    countryCode,
  });
}

function cityFromPhoton(payload: unknown): string | undefined {
  const feature = Array.isArray((payload as any)?.features) ? (payload as any).features[0] : undefined;
  const props = feature && typeof feature === "object" ? (feature as any).properties : undefined;
  if (!props || typeof props !== "object") return undefined;
  const city =
    (typeof props.city === "string" ? props.city : undefined) ||
    (typeof props.name === "string" ? props.name : undefined);
  const region = typeof props.state === "string" ? props.state : undefined;
  const country = typeof props.country === "string" ? props.country : undefined;
  const countryCode = typeof props.countrycode === "string" ? props.countrycode : undefined;
  if (!city) return undefined;
  return formatCityResult({
    city,
    region,
    country,
    countryCode,
  });
}

async function fetchJson(url: string, timeoutMs: number, fetchImpl?: typeof fetch): Promise<unknown> {
  const runFetch = fetchImpl || globalThis.fetch;
  if (!runFetch) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await runFetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": "dj-workspace-location-validator/1.0",
        Accept: "application/json",
      },
    });
    if (!response.ok) return undefined;
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeLocationCandidate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/^[\s:.-]+|[\s.]+$/g, "").trim();
  if (!cleaned) return undefined;
  if (/@|\$/.test(cleaned)) return undefined;
  if (LOCATION_BLOCKED_PATTERNS.some((pattern) => pattern.test(cleaned))) return undefined;
  return cleaned;
}

export function locationLooksLikeCity(value?: string): boolean {
  const normalized = normalizeLocationCandidate(value);
  if (!normalized) return false;
  if (canonicalAlias(normalized)) return true;
  if (locationIsStateOrCountryOnly(normalized)) return false;
  if (normalized.includes(",")) {
    return locationLooksLikeCityToken(firstLocationPart(normalized));
  }
  return locationLooksLikeCityToken(normalized);
}

export async function coerceLocationToCity(args: {
  location?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ location?: string; verified: boolean }> {
  const normalized = normalizeLocationCandidate(args.location);
  if (!normalized) {
    return { location: undefined, verified: false };
  }

  const alias = canonicalAlias(normalized);
  if (alias) {
    return { location: alias, verified: true };
  }

  if (locationIsStateOrCountryOnly(normalized)) {
    return { location: undefined, verified: false };
  }

  if (locationLooksLikeCity(normalized)) {
    return { location: normalized, verified: true };
  }

  // Venue-only labels without region context are ambiguous; default to NYC.
  if (locationLooksVenueLike(normalized) && !locationHasExplicitRegionHint(normalized)) {
    return { location: DEFAULT_FALLBACK_CITY, verified: false };
  }

  const key = normalized.toLowerCase();
  const cached = locationCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { location: cached.location, verified: cached.verified };
  }
  if (cached) {
    locationCache.delete(key);
  }

  if (Date.now() < apiCooldownUntil) {
    return { location: normalized, verified: false };
  }
  if (!locationApiEnabled()) {
    return { location: normalized, verified: false };
  }

  const timeoutMs = args.timeoutMs ?? LOCATION_API_TIMEOUT_MS;
  let resolved: string | undefined;
  let apiAttempted = false;
  try {
    apiAttempted = true;
    const q = encodeURIComponent(normalized);
    const fromNominatim = await fetchJson(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&q=${q}`,
      timeoutMs,
      args.fetchImpl
    );
    resolved = cityFromNominatim(fromNominatim);

    if (!resolved) {
      const fromPhoton = await fetchJson(
        `https://photon.komoot.io/api/?q=${q}&limit=1`,
        timeoutMs,
        args.fetchImpl
      );
      resolved = cityFromPhoton(fromPhoton);
    }
  } catch {
    apiCooldownUntil = Date.now() + LOCATION_API_COOLDOWN_MS;
  }

  const output = resolved || (apiAttempted ? undefined : normalized);
  const verified = Boolean(resolved);
  locationCache.set(key, {
    location: output,
    verified,
    expiresAt: Date.now() + LOCATION_CACHE_TTL_MS,
  });
  return { location: output, verified };
}

export async function coerceExtractedLocationToCity(args: {
  extracted: ExtractedInquiry;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ExtractedInquiry> {
  const next: ExtractedInquiry = {
    ...args.extracted,
    missingFields: Array.from(new Set(args.extracted.missingFields || [])),
  };

  const coerced = await coerceLocationToCity({
    location: next.location,
    fetchImpl: args.fetchImpl,
    timeoutMs: args.timeoutMs,
  });
  next.location = coerced.location;

  const missing = new Set(next.missingFields);
  if (next.location) {
    missing.delete("location");
  } else {
    missing.add("location");
  }
  next.missingFields = Array.from(missing);
  return next;
}
