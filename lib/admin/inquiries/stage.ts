import { BookingStage, Contract, Event, Invoice } from "../types/models";
import { parseDateToTimestamp } from "../utils/date";
import { isWithinDays } from "../utils/time";

export function detectStage(event: Event, contract?: Contract, invoice?: Invoice): BookingStage {
  if (event.stageOverride) {
    return event.stageOverride;
  }
  if (event.status === "cancelled") {
    return "cancelled";
  }
  if (event.status === "completed") {
    return "completed";
  }

  const depositReceived = invoice?.status === "paid_partial" || invoice?.status === "paid" || event.depositStatus === "received";
  const signedContract = Boolean(event.signedContract);
  const initialDepositReceived =
    typeof event.initialDepositReceived === "boolean" ? event.initialDepositReceived : depositReceived;

  if (!signedContract || !initialDepositReceived) {
    return "inquiry";
  }

  const eventDateValue = parseDateToTimestamp(event.eventDate) || event.eventDateTimestamp || event.eventDate;
  if (isWithinDays(eventDateValue, 30)) {
    return "execution";
  }

  return "in_contract";
}
