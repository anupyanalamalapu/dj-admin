import { normalizeTimestamp } from "./date";

export function nowIso(): string {
  return new Date().toISOString();
}

export function toDate(value?: string | number): Date | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = typeof value === "number" ? normalizeTimestamp(value) : value;
  if (typeof normalized === "undefined") {
    return undefined;
  }
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function isWithinDays(dateValue: string | number | undefined, days: number): boolean {
  const target = toDate(dateValue);
  if (!target) {
    return false;
  }
  const now = new Date();
  const diffMs = target.getTime() - now.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays >= 0 && diffDays <= days;
}
