import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectStage } from "../../../lib/admin/inquiries/stage";
import type { Contract, Event, Invoice } from "../../../lib/admin/types/models";

function baseEvent(): Event {
  return {
    id: "event_1",
    clientId: "client_1",
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
  };
}

describe("detectStage", () => {
  it("returns inquiry for initial event", () => {
    assert.equal(detectStage(baseEvent()), "inquiry");
  });

  it("returns in_contract only after checklist is complete", () => {
    const event = baseEvent();
    event.signedContract = true;
    event.initialDepositReceived = true;
    event.eventDate = "2099-12-01";
    const contract: Contract = {
      id: "contract_1",
      eventId: event.id,
      clientId: event.clientId,
      version: 1,
      status: "draft",
      dynamicFields: {
        eventDetails: [],
        travelAmount: 0,
        totalAmount: 0,
        depositAmount: 0,
        remainingAmount: 0,
        dueDate: "",
        cancellationDate: "",
      },
      legalBody: "",
      renderedText: "",
      createdAt: "",
      updatedAt: "",
    };

    assert.equal(detectStage(event, contract), "in_contract");
  });

  it("returns execution when checklist is complete and event is within 30 days", () => {
    const event = baseEvent();
    const nearFuture = new Date();
    nearFuture.setDate(nearFuture.getDate() + 7);
    event.eventDate = nearFuture.toISOString();
    event.signedContract = true;
    event.initialDepositReceived = true;

    const contract: Contract = {
      id: "contract_1",
      eventId: event.id,
      clientId: event.clientId,
      version: 1,
      status: "approved",
      dynamicFields: {
        eventDetails: [],
        travelAmount: 0,
        totalAmount: 0,
        depositAmount: 0,
        remainingAmount: 0,
        dueDate: "",
        cancellationDate: "",
      },
      legalBody: "",
      renderedText: "",
      createdAt: "",
      updatedAt: "",
    };

    const invoice: Invoice = {
      id: "invoice_1",
      eventId: event.id,
      clientId: event.clientId,
      services: [],
      amount: 1000,
      depositAmount: 250,
      balanceRemaining: 750,
      status: "paid_partial",
      createdAt: "",
      updatedAt: "",
    };

    assert.equal(detectStage(event, contract, invoice), "execution");
  });

  it("returns cancelled when status is cancelled", () => {
    const event = baseEvent();
    event.status = "cancelled";
    event.signedContract = true;
    event.initialDepositReceived = true;
    event.eventDate = "2099-12-01";

    assert.equal(detectStage(event), "cancelled");
  });

  it("returns completed when status is completed", () => {
    const event = baseEvent();
    event.status = "completed";
    event.eventDate = "2001-01-01";

    assert.equal(detectStage(event), "completed");
  });
});
