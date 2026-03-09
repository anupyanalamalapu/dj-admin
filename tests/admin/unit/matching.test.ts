import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchExistingClientAndEvent } from "../../../lib/admin/inquiries/matching";
import type { Client, Event, ExtractedInquiry } from "../../../lib/admin/types/models";

describe("matchExistingClientAndEvent", () => {
  it("matches by exact email", () => {
    const clients: Client[] = [
      {
        id: "client_1",
        fullName: "Sarah Lee",
        email: "sarah@example.com",
        secondaryEmails: [],
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      },
    ];
    const events: Event[] = [
      {
        id: "event_1",
        clientId: "client_1",
        eventType: "Wedding",
        eventDate: "2026-09-26",
        venue: "DC",
        servicesRequested: [],
        status: "inquiry_received",
        depositStatus: "none",
        stage: "inquiry",
        inquiryIds: [],
        communicationIds: [],
        documentIds: [],
        latestDraftEmail: "",
        latestOcrText: "",
        latestNotes: "",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      },
    ];
    const extracted: ExtractedInquiry = {
      email: "sarah@example.com",
      clientName: "Sarah Lee",
      eventDate: "2026-09-26",
      location: "DC",
      servicesRequested: [],
      missingFields: [],
    };

    const result = matchExistingClientAndEvent({ clients, events, extracted, rawText: "" });
    assert.equal(result.clientId, "client_1");
    assert.equal(result.eventId, "event_1");
  });

  it("matches by fuzzy name when email missing", () => {
    const clients: Client[] = [
      {
        id: "client_1",
        fullName: "Shohini Banerjee",
        email: "shohini@example.com",
        secondaryEmails: [],
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      },
    ];

    const result = matchExistingClientAndEvent({
      clients,
      events: [],
      extracted: { clientName: "Shohini B.", servicesRequested: [], missingFields: [] },
      rawText: "",
    });

    assert.equal(result.clientId, "client_1");
    assert.equal(result.reason, "matched_by_name");
  });

  it("attaches follow-up by name to latest event when date/location missing", () => {
    const clients: Client[] = [
      {
        id: "client_1",
        fullName: "Anjali Trivedi",
        email: "anjali@example.com",
        secondaryEmails: [],
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      },
    ];
    const events: Event[] = [
      {
        id: "event_old",
        clientId: "client_1",
        eventType: "Wedding",
        eventDate: "2026-05-01",
        venue: "Legacy Castle",
        servicesRequested: [],
        status: "inquiry_received",
        depositStatus: "none",
        stage: "inquiry",
        inquiryIds: [],
        communicationIds: [],
        documentIds: [],
        latestDraftEmail: "",
        latestOcrText: "",
        latestNotes: "",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      },
      {
        id: "event_latest",
        clientId: "client_1",
        eventType: "Wedding",
        eventDate: "2027-05-23",
        venue: "The Rockleigh",
        servicesRequested: [],
        status: "inquiry_received",
        depositStatus: "none",
        stage: "inquiry",
        inquiryIds: [],
        communicationIds: [],
        documentIds: [],
        latestDraftEmail: "",
        latestOcrText: "",
        latestNotes: "",
        createdAt: "2026-02-01",
        updatedAt: "2026-03-01",
      },
    ];

    const result = matchExistingClientAndEvent({
      clients,
      events,
      extracted: { clientName: "Anjali Trivedi", servicesRequested: ["dhol", "mc"], missingFields: [] },
      rawText: "Thanks in advance, Anjali Trivedi",
    });

    assert.equal(result.clientId, "client_1");
    assert.equal(result.eventId, "event_latest");
    assert.equal(result.reason, "matched_by_name");
  });

  it("matches by instagram handle when provided", () => {
    const clients: Client[] = [
      {
        id: "client_1",
        fullName: "Lina Torres",
        email: "lina@example.com",
        instagramHandle: "@linatorres",
        secondaryEmails: [],
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      },
    ];
    const events: Event[] = [
      {
        id: "event_1",
        clientId: "client_1",
        eventType: "Wedding",
        eventDate: "2027-07-05",
        venue: "LA",
        servicesRequested: [],
        status: "inquiry_received",
        depositStatus: "none",
        stage: "inquiry",
        inquiryIds: [],
        communicationIds: [],
        documentIds: [],
        latestDraftEmail: "",
        latestOcrText: "",
        latestNotes: "",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      },
    ];

    const result = matchExistingClientAndEvent({
      clients,
      events,
      extracted: { instagramHandle: "@linatorres", servicesRequested: [], missingFields: [] },
      rawText: "IG: @linatorres",
    });

    assert.equal(result.clientId, "client_1");
    assert.equal(result.reason, "matched_by_instagram");
  });
});
