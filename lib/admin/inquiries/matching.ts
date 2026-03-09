import { Client, Event, ExtractedInquiry } from "../types/models";
import { parseDateToTimestamp } from "../utils/date";

export interface MatchResult {
  clientId?: string;
  eventId?: string;
  reason: string;
  confidence?: number;
}

function isSameEventDate(event: Event, extracted: ExtractedInquiry): boolean {
  const eventTs = parseDateToTimestamp(event.eventDate) || event.eventDateTimestamp;
  const extractedTs = parseDateToTimestamp(extracted.eventDate) || extracted.eventDateTimestamp;

  if (eventTs && extractedTs) {
    const eventDay = Math.floor(eventTs / 86400000);
    const extractedDay = Math.floor(extractedTs / 86400000);
    return eventDay === extractedDay;
  }

  if (event.eventDate && extracted.eventDate) {
    return event.eventDate === extracted.eventDate;
  }

  return false;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function scoreName(nameA: string, nameB: string): number {
  const a = normalize(nameA);
  const b = normalize(nameB);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.8;

  const minLen = Math.min(a.length, b.length);
  let same = 0;
  for (let i = 0; i < minLen; i += 1) {
    if (a[i] === b[i]) same += 1;
  }
  return same / Math.max(a.length, b.length);
}

function latestEventForClient(events: Event[], clientId: string): Event | undefined {
  return events
    .filter((item) => item.clientId === clientId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

function matchedEventForClient(args: {
  events: Event[];
  clientId: string;
  extracted: ExtractedInquiry;
}): Event | undefined {
  const scoped = args.events.filter((item) => item.clientId === args.clientId);
  const byDetails = scoped.find(
    (item) =>
      isSameEventDate(item, args.extracted) ||
      (!!args.extracted.location && item.venue?.toLowerCase().includes(args.extracted.location.toLowerCase()))
  );
  return byDetails || latestEventForClient(args.events, args.clientId);
}

export function matchExistingClientAndEvent(args: {
  clients: Client[];
  events: Event[];
  extracted: ExtractedInquiry;
  rawText: string;
}): MatchResult {
  const { clients, events, extracted, rawText } = args;
  const lowered = rawText.toLowerCase();

  if (extracted.email) {
    const byEmail = clients.find(
      (client) =>
        client.email.toLowerCase() === extracted.email!.toLowerCase() ||
        client.secondaryEmails.some((email) => email.toLowerCase() === extracted.email!.toLowerCase())
    );
    if (byEmail) {
      const event = matchedEventForClient({
        events,
        clientId: byEmail.id,
        extracted,
      });

      return {
        clientId: byEmail.id,
        eventId: event?.id,
        reason: "matched_by_email",
        confidence: 0.98,
      };
    }
  }

  if (extracted.phone) {
    const normalizedPhone = extracted.phone.replace(/\D/g, "");
    const byPhone = clients.find((client) => (client.phone || "").replace(/\D/g, "") === normalizedPhone);
    if (byPhone) {
      const event = matchedEventForClient({
        events,
        clientId: byPhone.id,
        extracted,
      });
      return {
        clientId: byPhone.id,
        eventId: event?.id,
        reason: "matched_by_phone",
        confidence: 0.95,
      };
    }
  }

  if (extracted.instagramHandle) {
    const normalizedHandle = extracted.instagramHandle.replace(/^@+/, "").toLowerCase();
    const byHandle = clients.find(
      (client) => (client.instagramHandle || "").replace(/^@+/, "").toLowerCase() === normalizedHandle
    );
    if (byHandle) {
      const event = matchedEventForClient({
        events,
        clientId: byHandle.id,
        extracted,
      });
      return {
        clientId: byHandle.id,
        eventId: event?.id,
        reason: "matched_by_instagram",
        confidence: 0.95,
      };
    }
  }

  if (extracted.clientName) {
    const sorted = clients
      .map((client) => ({ client, score: scoreName(client.fullName, extracted.clientName!) }))
      .sort((a, b) => b.score - a.score);

    if (sorted[0] && sorted[0].score >= 0.72) {
      const matchedClient = sorted[0].client;
      const event = matchedEventForClient({
        events,
        clientId: matchedClient.id,
        extracted,
      });
      return {
        clientId: matchedClient.id,
        eventId: event?.id,
        reason: "matched_by_name",
        confidence: sorted[0].score,
      };
    }
  }

  if (extracted.eventDate || extracted.eventDateTimestamp || extracted.location) {
    const event = events.find((item) => {
      const dateOk = isSameEventDate(item, extracted);
      const venueOk = extracted.location ? item.venue?.toLowerCase().includes(extracted.location.toLowerCase()) : false;
      return dateOk || venueOk;
    });

    if (event) {
      return {
        clientId: event.clientId,
        eventId: event.id,
        reason: "matched_by_event_fields",
        confidence: 0.82,
      };
    }
  }

  const contractRef = rawText.match(/contract\s*(?:#|ref)?\s*[:\-]?\s*([a-z0-9_-]{6,})/i)?.[1];
  if (contractRef) {
    const event = events.find((item) => lowered.includes(item.id.toLowerCase()));
    if (event) {
      return {
        clientId: event.clientId,
        eventId: event.id,
        reason: "matched_by_contract_reference",
        confidence: 0.93,
      };
    }
  }

  return { reason: "new_client" };
}
