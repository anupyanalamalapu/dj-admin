import { CONTRACT_LEGAL_BODY } from "./template";
import { normalizeDynamicFields } from "./calc";
import { ContractDynamicFields } from "../types/models";
import { formatDateLong, parseDateToTimestamp } from "../utils/date";

function money(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value || 0);
}

function hasManualOverride(event: ContractDynamicFields["eventDetails"][number]): boolean {
  return (
    typeof event.manualOverridePrice === "number" &&
    Number.isFinite(event.manualOverridePrice) &&
    event.manualOverridePrice >= 0 &&
    event.manualOverridePrice !== event.amount
  );
}

function eventCostHtml(event: ContractDynamicFields["eventDetails"][number]): string {
  if (!hasManualOverride(event)) {
    return money(event.amount);
  }
  return `<span class="strike">${money(event.amount)}</span>${money(event.manualOverridePrice || 0)}`;
}

function eventCostText(event: ContractDynamicFields["eventDetails"][number]): string {
  if (!hasManualOverride(event)) {
    return money(event.amount);
  }
  return `~~${money(event.amount)}~~ ${money(event.manualOverridePrice || 0)}`;
}

function normalizeContractDate(value?: string): string {
  if (!value) return "";
  const timestamp = parseDateToTimestamp(value);
  if (!timestamp) return value;
  return formatDateLong({ timestamp, isoDate: value, fallback: value });
}

function stripLegacySignatureSection(legalBody: string): string {
  return (legalBody || "")
    .replace(/\n*\s*SIGNATURES[\s\S]*$/i, "")
    .trim();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function legalBodyToHtml(legalBody: string): string {
  const blocks = legalBody
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (!blocks.length) {
    return "";
  }

  return `<div class="legal-block">${blocks
    .map((block) => `<p>${escapeHtml(block)}</p>`)
    .join("\n")}</div>`;
}

function dynText(value: string): string {
  return `<span class="dyn">${escapeHtml(value)}</span>`;
}

function dynHtml(value: string): string {
  return `<span class="dyn">${value}</span>`;
}

export function renderContractHtml(args: {
  clientName: string;
  fields: ContractDynamicFields;
  legalBody?: string;
}): string {
  const normalizedFields = normalizeDynamicFields(args.fields);
  const sanitizedLegalBody = stripLegacySignatureSection(args.legalBody || CONTRACT_LEGAL_BODY);
  const legalHtml = legalBodyToHtml(sanitizedLegalBody);

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>DJ Wedding Contract</title>
  <style>
    @page { margin: 20mm 18mm; }
    body {
      font-family: Georgia, "Times New Roman", serif;
      font-size: 13px;
      color: #111827;
      margin: 0;
      line-height: 1.45;
      background: #ffffff;
    }
    .doc {
      max-width: 760px;
      margin: 0 auto;
    }
    h1 {
      text-align: center;
      font-size: 13px;
      margin: 0 0 20px 0;
      font-weight: 700;
    }
    p {
      margin: 10px 0;
    }
    .section-title {
      font-size: 13px;
      font-weight: 700;
      margin: 18px 0 8px 0;
      text-decoration: underline;
    }
    .party-line {
      margin-bottom: 16px;
    }
    .event-list {
      margin: 0 0 10px 0;
      padding-left: 0;
      list-style: none;
    }
    .event-item {
      margin: 0 0 10px 0;
    }
    .event-main {
      font-weight: 700;
      margin-bottom: 2px;
      font-size: 13px;
    }
    .event-sub {
      margin-left: 18px;
      font-size: 13px;
    }
    .total-line {
      font-weight: 700;
      margin-top: 10px;
      font-size: 13px;
    }
    .legal-block h3 {
      display: none;
    }
    .legal-block p {
      margin: 10px 0;
      color: #111827;
      white-space: pre-line;
    }
    .signature-block {
      margin-top: 28px;
    }
    .signature-line {
      margin: 18px 0 8px 0;
    }
    .dyn {
      color: #1d4ed8;
      font-weight: 700;
    }
    .strike {
      text-decoration: line-through;
      opacity: 0.75;
      margin-right: 6px;
    }
  </style>
</head>
<body>
  <div class="doc">
    <h1>DJ Wedding Contract</h1>

    <p class="party-line">
      <strong>Contracting Party:</strong> ${dynText(args.clientName)} &nbsp;&nbsp;&nbsp;
      <strong>Contractor:</strong> DJ Anupya
    </p>

    <div class="section-title">Event Information:</div>
    <div class="event-list">
      ${normalizedFields.eventDetails
        .map(
          (event) => `
            <div class="event-item">
              <div class="event-main">- ${dynText(event.title || "")}</div>
              <div class="event-sub">- ${dynText(normalizeContractDate(event.date || ""))}, from ${dynText(event.time || "")}</div>
              <div class="event-sub">- Location: ${dynText(event.location || "")}</div>
              <div class="event-sub">- Total Cost: ${dynHtml(eventCostHtml(event))}</div>
            </div>
          `
        )
        .join("")}
    </div>

    <p class="total-line">- Total: ${dynHtml(money(normalizedFields.totalAmount))} (Including ${dynHtml(money(normalizedFields.travelAmount))} Travel from NYC/Accommodation)</p>

    <div class="section-title">Services:</div>
    <p>
      The DJ's responsibility is to provide custom musical entertainment to event attendees at the location and times listed above.
      Any additional venues will be subject to a fee that will need an alteration of this contract. Specific music requests will
      be provided only by the wedding party ahead of time. Any requests made by parties not specified in this contract will be heard,
      but action on their requests will be up to the DJ's discretion. The set list will be curated beforehand according to the wedding
      party's specifications.
    </p>

    <div class="section-title">Equipment:</div>
    <p>
      The wedding party agrees to provide speakers and a table at all events, and will communicate the necessary additional wires
      and/or mics needed for the events. The DJ shall be responsible for providing:<br/><br/>
      - Laptop with Controller Software (Serato)<br/><br/>
      Wedding party shall be responsible for providing:<br/>
      - A DJ Board compatible with Serato (SR2 / FLX10 / XDJ XZ / etc.)<br/>
      - If unable to add this via AV company, wedding party will notify the DJ<br/><br/>
      The DJ will also receive a liaison from the wedding party to provide guidance during the day.<br/><br/>
      If any damage to the provided equipment or DJ team occurs during any interaction with an associate of the contracting party,
      or between the time of arrival to the designated venue and the time of departure from the designated venue, the contracting party
      will be in charge of replacing the equipment and compensating for any damages accordingly.
    </p>

    <div class="section-title">Compensation:</div>
    <p>
      Services at all events will be given for a total of ${dynHtml(money(normalizedFields.totalAmount))}. A non-refundable deposit of 25%
      (${dynHtml(money(normalizedFields.depositAmount))}) will be paid within 7 days of contract execution. The remaining 75%
      (${dynHtml(money(normalizedFields.remainingAmount))}) will be paid on ${dynText(normalizeContractDate(normalizedFields.dueDate || ""))}. Any late payments
      past this date will result in an additional charge of $150 per day. In the event that the specified event(s) go beyond
      the time stated above, the contracting party shall pay the DJ at a rate of $700 per hour for each hour the event goes
      beyond the time stated above. Partial hours will be prorated.
    </p>

    <p>
      Payments must be delivered in the form of cash or a check made out to "Anupya Nalamalapu". In addition to the above
      compensation of services, the wedding party will provide.
    </p>

    <div class="section-title">Cancellation:</div>
    <p>
      The contracting party may cancel this agreement at any time before ${dynText(normalizeContractDate(normalizedFields.cancellationDate || ""))}.
      Upon cancellation, however, the contracting party will be entitled to a refund of any funds paid to the DJ, except for
      the non-refundable deposit and any flights and/or hotels that have been booked. Cancellation on the day of any of the
      events by the contracting party will be accepted, but the contracting party shall pay the full amount of the service.
    </p>

    <p>
      In the unlikely event that the DJ is unable to attend the event(s) due to personal reasons, it shall be the duty of the DJ
      to arrange a replacement DJ as required to fulfill this contract agreement. In the event that the DJ cannot provide the requested
      service and cannot provide any replacements, the DJ shall refund any fees (excluding flight and hotel) previously paid by the
      contracting party, including the 25% deposit.
    </p>

    ${legalHtml}

    <div class="signature-block">
      <p><strong>Signatures guarantee that parties must abide by the terms of this agreement and intend to be legally bound thereby:</strong></p>

      <p>[Contracting Party]</p>
      <p class="signature-line">Name: _________________________________________________</p>
      <p class="signature-line">Signature: _____________________________________________</p>
      <p class="signature-line">Date: ___________________________________________________</p>

      <p style="margin-top: 22px;">[Contractor]</p>
      <p class="signature-line">Name: DJ Anupya _____________________________________</p>
      <p class="signature-line">Signature: _____________________________________________</p>
      <p class="signature-line">Date: ___________________________________________________</p>
    </div>
  </div>
</body>
</html>`;
}

export function renderContract(
  fields: ContractDynamicFields,
  legalBody: string = CONTRACT_LEGAL_BODY,
  clientName: string = "Client"
): {
  normalizedFields: ContractDynamicFields;
  renderedText: string;
} {
  const normalizedFields = normalizeDynamicFields(fields);
  const sanitizedLegalBody = stripLegacySignatureSection(legalBody || CONTRACT_LEGAL_BODY);

  const eventLines = normalizedFields.eventDetails
    .map(
      (event) =>
        `- ${event.title || ""}\n  - ${normalizeContractDate(event.date || "")}, from ${event.time || ""}\n  - Location: ${event.location || ""}\n  - Total Cost: ${eventCostText(event)}`
    )
    .join("\n");

  const renderedText = `DJ Wedding Contract

Contracting Party: ${clientName}
Contractor: DJ Anupya

Event Information:
${eventLines}
- Total: ${money(normalizedFields.totalAmount)} (Including ${money(normalizedFields.travelAmount)} Travel from NYC/Accommodation)

Services:
The DJ's responsibility is to provide custom musical entertainment to event attendees at the location and times listed above. Any additional venues will be subject to a fee that will need an alteration of this contract. Specific music requests will be provided only by the wedding party ahead of time. Any requests made by parties not specified in this contract will be heard, but action on their requests will be up to the DJ's discretion. The set list will be curated beforehand according to the wedding party's specifications.

Equipment:
The wedding party agrees to provide speakers and a table at all events, and will communicate the necessary additional wires and/or mics needed for the events. The DJ shall be responsible for providing:
- Laptop with Controller Software (Serato)
Wedding party shall be responsible for providing:
- A DJ Board compatible with Serato (SR2 / FLX10 / XDJ XZ / etc.)
- If unable to add this via AV company, wedding party will notify the DJ
The DJ will also receive a liaison from the wedding party to provide guidance during the day.
If any damage to the provided equipment or DJ team occurs during any interaction with an associate of the contracting party, or between the time of arrival to the designated venue and the time of departure from the designated venue, the contracting party will be in charge of replacing the equipment and compensating for any damages accordingly.

Compensation:
Services at all events will be given for a total of ${money(normalizedFields.totalAmount)}. A non-refundable deposit of 25% (${money(normalizedFields.depositAmount)}) will be paid within 7 days of contract execution. The remaining 75% (${money(normalizedFields.remainingAmount)}) will be paid on ${normalizeContractDate(normalizedFields.dueDate || "")}. Any late payments past this date will result in an additional charge of $150 per day. In the event that the specified event(s) go beyond the time stated above, the contracting party shall pay the DJ at a rate of $700 per hour for each hour the event goes beyond the time stated above. Partial hours will be prorated.

Cancellation:
The contracting party may cancel this agreement at any time before ${normalizeContractDate(normalizedFields.cancellationDate || "")}. Upon cancellation, however, the contracting party will be entitled to a refund of any funds paid to the DJ, except for the non-refundable deposit and any flights and/or hotels that have been booked. Cancellation on the day of any of the events by the contracting party will be accepted, but the contracting party shall pay the full amount of the service.

${sanitizedLegalBody}

Signatures guarantee that parties must abide by the terms of this agreement and intend to be legally bound thereby:
[Contracting Party]
Name: _________________________________________________
Signature: _____________________________________________
Date: ___________________________________________________

[Contractor]
Name: DJ Anupya _____________________________________
Signature: _____________________________________________
Date: ___________________________________________________
`;

  return {
    normalizedFields,
    renderedText,
  };
}

export function buildAmendmentSuggestion(args: {
  priorContractText: string;
  inboundMessage: string;
}): string {
  return `Suggested amendment based on latest inbound message:\n- Review requested scope changes and update pricing rows in dynamic event details.\n- Recalculate total/deposit/remainder and due dates.\n- Preserve legal boilerplate.\n\nInbound context:\n${args.inboundMessage.slice(0, 500)}\n\nCurrent contract excerpt:\n${args.priorContractText.slice(0, 500)}`;
}
