import fs from "fs/promises";
import path from "path";
import {
  Client,
  Communication,
  Contract,
  DocumentMeta,
  Event,
  Invoice,
  Inquiry,
} from "../types/models";
import { getClientsDir } from "../persistence/paths";

function lineDate(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

export async function updateClientMarkdown(args: {
  client: Client;
  events: Event[];
  inquiries: Inquiry[];
  contracts: Contract[];
  invoices: Invoice[];
  documents: DocumentMeta[];
  communications: Communication[];
}): Promise<void> {
  const { client, events, inquiries, contracts, invoices, documents, communications } = args;

  await fs.mkdir(getClientsDir(), { recursive: true });
  const pathName = path.join(getClientsDir(), `client_${client.id}.md`);

  const latestEvent = [...events].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const latestContract = latestEvent
    ? contracts
        .filter((contract) => contract.eventId === latestEvent.id)
        .sort((a, b) => b.version - a.version)[0]
    : undefined;
  const latestInvoice = latestEvent ? invoices.find((invoice) => invoice.eventId === latestEvent.id) : undefined;

  const comms = communications
    .filter((item) => item.clientId === client.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-8);

  const docList = documents.filter((item) => item.clientId === client.id);
  const inquiryList = inquiries.filter((item) => item.clientId === client.id);

  const body = `# Client: ${client.fullName}

## Current Stage
${latestEvent?.stage || "inquiry"}

## Contact Info
- primary email: ${client.email}
- phone: ${client.phone || ""}
- instagram: ${client.instagramHandle || ""}
- secondary email(s): ${client.secondaryEmails.join(", ")}

## Event Summary
- date(s): ${events.map((event) => event.eventDate || "").filter(Boolean).join(", ")}
- city/venue: ${events.map((event) => event.venue || "").filter(Boolean).join(", ")}
- event types: ${events.map((event) => event.eventType || "").filter(Boolean).join(", ")}
- status: ${latestEvent?.status || "inquiry_received"}
- deposit status: ${latestEvent?.depositStatus || "none"}

## Contract Summary
- current contract version: ${latestContract?.version || "n/a"}
- total: ${latestContract ? latestContract.dynamicFields.totalAmount : "n/a"}
- deposit: ${latestContract ? latestContract.dynamicFields.depositAmount : "n/a"}
- remaining balance: ${latestContract ? latestContract.dynamicFields.remainingAmount : "n/a"}
- cancellation deadline: ${latestContract?.dynamicFields.cancellationDate || "n/a"}

## Invoice Summary
- amount: ${latestInvoice?.amount || "n/a"}
- deposit amount: ${latestInvoice?.depositAmount || "n/a"}
- remaining: ${latestInvoice?.balanceRemaining || "n/a"}
- due date: ${latestInvoice?.paymentDueDate || "n/a"}

## Recent Communications
${comms.map((entry) => `- [${lineDate(entry.createdAt)}] ${entry.kind}: ${entry.content.slice(0, 120)}`).join("\n")}

## Recent Inquiries
${inquiryList
  .slice(-5)
  .map((entry) => `- [${lineDate(entry.createdAt)}] ${entry.rawText.slice(0, 140)}`)
  .join("\n")}

## Documents
${docList.map((doc) => `- ${doc.filename}`).join("\n")}
`;

  await fs.writeFile(pathName, body, "utf8");
}
