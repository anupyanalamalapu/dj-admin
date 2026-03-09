import { ContractDynamicFields, PricingRow } from "../types/models";

function normalizeOptionalMoney(value: unknown): number | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return undefined;
  return numeric;
}

function effectiveEventAmount(item: ContractDynamicFields["eventDetails"][number]): number {
  const override = normalizeOptionalMoney(item.manualOverridePrice);
  if (typeof override === "number") {
    return override;
  }
  return Number(item.amount || 0);
}

function normalizeUniqueDetailIds(
  details: ContractDynamicFields["eventDetails"]
): ContractDynamicFields["eventDetails"] {
  const used = new Set<string>();
  return details.map((item, index) => {
    const base = (item.id || "").trim() || `detail_${index + 1}`;
    let nextId = base;
    let suffix = 2;
    while (used.has(nextId)) {
      nextId = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(nextId);
    return {
      ...item,
      id: nextId,
    };
  });
}

export function calculateTotals(rows: PricingRow[], travelAmount: number): {
  totalAmount: number;
  depositAmount: number;
  remainingAmount: number;
} {
  const eventsTotal = rows.reduce((sum, row) => sum + (Number.isFinite(row.amount) ? row.amount : 0), 0);
  const totalAmount = eventsTotal + (Number.isFinite(travelAmount) ? travelAmount : 0);
  const depositAmount = Math.round(totalAmount * 0.25);
  const remainingAmount = totalAmount - depositAmount;

  return {
    totalAmount,
    depositAmount,
    remainingAmount,
  };
}

export function normalizeDynamicFields(fields: ContractDynamicFields): ContractDynamicFields {
  const normalizedEventDetails = normalizeUniqueDetailIds(fields.eventDetails);
  const rows: PricingRow[] = normalizedEventDetails.map((item) => ({
    id: item.id,
    label: item.title,
    eventDate: item.date,
    startTime: item.time,
    endTime: undefined,
    location: item.location,
    amount: effectiveEventAmount(item),
  }));

  const totals = calculateTotals(rows, Number(fields.travelAmount || 0));

  return {
    ...fields,
    travelAmount: Number(fields.travelAmount || 0),
    totalAmount: totals.totalAmount,
    depositAmount: totals.depositAmount,
    remainingAmount: totals.remainingAmount,
    eventDetails: normalizedEventDetails.map((item) => ({
      ...item,
      amount: Number(item.amount || 0),
      manualOverridePrice: normalizeOptionalMoney(item.manualOverridePrice),
    })),
  };
}
