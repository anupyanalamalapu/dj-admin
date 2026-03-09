import { ContractDynamicFields, Invoice } from "../types/models";

export function invoiceFromContract(args: {
  invoice?: Invoice;
  eventId: string;
  clientId: string;
  fields: ContractDynamicFields;
  services: string[];
  nowIso: string;
}): Invoice {
  const { invoice, eventId, clientId, fields, services, nowIso } = args;
  if (invoice) {
    return {
      ...invoice,
      amount: fields.totalAmount,
      depositAmount: fields.depositAmount,
      balanceRemaining: fields.remainingAmount,
      services,
      paymentDueDate: fields.dueDate,
      updatedAt: nowIso,
    };
  }

  return {
    id: `invoice_${eventId}`,
    eventId,
    clientId,
    services,
    amount: fields.totalAmount,
    depositAmount: fields.depositAmount,
    balanceRemaining: fields.remainingAmount,
    status: "draft",
    paymentDueDate: fields.dueDate,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

export function suggestInvoiceUpdates(args: {
  message: string;
  currentAmount: number;
}): string {
  const message = args.message.toLowerCase();
  const hints: string[] = [];

  if (message.includes("add") || message.includes("additional")) {
    hints.push("Potential added scope detected; review service rows for extra line items.");
  }
  if (message.includes("hour") || message.includes("timing")) {
    hints.push("Timing adjustment detected; verify overtime or duration pricing.");
  }
  if (message.includes("travel") || message.includes("hotel") || message.includes("flight")) {
    hints.push("Travel/accommodation adjustment detected; revisit travel amount.");
  }

  if (!hints.length) {
    hints.push("No obvious pricing triggers detected; confirm if invoice changes are needed.");
  }

  return `Current invoice total: $${args.currentAmount}. ${hints.join(" ")}`;
}
