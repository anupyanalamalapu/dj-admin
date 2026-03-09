export interface InquiryProcessingPayload {
  rawText: string;
  ocrText?: string;
  combinedText: string;
  senderEmailHint?: string;
  senderNameHint?: string;
  signatureNameHint?: string;
}

function normalize(input: string): string {
  return input.replace(/\r/g, "").trim();
}

function cleanName(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;

  return normalized
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

const TO_LINE_STOP_WORDS = new Set([
  "share",
  "your",
  "name",
  "photo",
  "yesterday",
  "today",
  "delivered",
  "message",
  "imessage",
  "sent",
  "read",
  "at",
  "pm",
  "am",
]);

export function extractToLineName(rawText: string): string | undefined {
  const text = normalize(rawText);
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^to:\s*(.+)$/i);
    if (!match?.[1]) continue;
    const tokens = (match[1].match(/[A-Za-z][A-Za-z.'-]*/g) || []).filter(Boolean);
    if (!tokens.length) continue;

    const candidate: string[] = [];
    for (const token of tokens) {
      const lowered = token.toLowerCase();
      if (candidate.length > 0 && TO_LINE_STOP_WORDS.has(lowered)) {
        break;
      }
      if (TO_LINE_STOP_WORDS.has(lowered)) {
        continue;
      }
      candidate.push(token);
      if (candidate.length >= 4) break;
    }
    if (!candidate.length) continue;

    const joined = cleanName(candidate.join(" "));
    if (joined) return joined;
  }
  return undefined;
}

function isLikelyPersonName(value?: string): boolean {
  if (!value) return false;
  const normalized = value.trim();
  if (!normalized) return false;
  if (!/[A-Za-z]/.test(normalized)) return false;

  const blockedTerms = ["gmail", "yahoo", "outlook", "from", "to", "subject", "hours ago", "wedding", "event"];
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
  const lowered = normalized.toLowerCase();
  if (blockedTerms.some((term) => lowered.includes(term))) {
    return false;
  }

  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length < 1 || parts.length > 4) return false;
  if (parts.length === 1) {
    const part = parts[0];
    if (blockedStandalone.has(part.toLowerCase())) return false;
    return /^[A-Za-z][A-Za-z.'-]{1,29}$/.test(part);
  }
  return parts.every((part) => /^[A-Za-z][A-Za-z.'-]*$/.test(part));
}

export function extractSenderFromHeader(rawText: string): { senderNameHint?: string; senderEmailHint?: string } {
  const text = normalize(rawText);
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const firstLine = lines.find((line) => line.trim());
  if (!firstLine) {
    return {};
  }

  const email = firstLine.match(/([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i)?.[1];
  const name = firstLine.match(/^\s*([^<\n]+?)\s*<\s*[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\s*>/i)?.[1];

  const toLineName = extractToLineName(text);

  return {
    senderEmailHint: email,
    senderNameHint: cleanName(name || toLineName),
  };
}

export function extractSignatureName(rawText: string): string | undefined {
  const text = normalize(rawText);
  const lines = text.split("\n").map((line) => line.trim());

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i]) {
      continue;
    }
    if (/^(best|thanks|thank you|regards|sincerely|warmly|cheers)[,!]?$/i.test(lines[i])) {
      for (let j = i + 1; j < lines.length; j += 1) {
        if (!lines[j]) continue;
        const candidate = cleanName(lines[j]);
        if (isLikelyPersonName(candidate)) {
          return candidate;
        }
        break;
      }
    }
  }

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const candidate = cleanName(lines[i]);
    if (!candidate) continue;
    if (isLikelyPersonName(candidate)) return candidate;
  }
  return undefined;
}

export function buildInquiryProcessingPayload(args: {
  messageText: string;
  ocrText?: string;
}): InquiryProcessingPayload {
  const messageText = normalize(args.messageText || "");
  const ocrText = normalize(args.ocrText || "");
  const combinedText = [messageText, ocrText].filter(Boolean).join("\n\n").trim();

  const header = extractSenderFromHeader(combinedText);
  const signatureNameHint = extractSignatureName(combinedText);

  return {
    rawText: messageText,
    ocrText: ocrText || undefined,
    combinedText,
    senderEmailHint: header.senderEmailHint,
    senderNameHint: header.senderNameHint,
    signatureNameHint,
  };
}

export function toInquiryProcessingJson(payload: InquiryProcessingPayload): string {
  return JSON.stringify(
    {
      rawText: payload.rawText,
      ocrText: payload.ocrText || null,
      combinedText: payload.combinedText,
      hints: {
        senderEmailHint: payload.senderEmailHint || null,
        senderNameHint: payload.senderNameHint || null,
        signatureNameHint: payload.signatureNameHint || null,
      },
    },
    null,
    2
  );
}
