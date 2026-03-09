import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatDateLong, formatDateTimeRange, parseDateToTimestamp, timestampToIsoDate } from "../../../lib/admin/utils/date";
import { toDate } from "../../../lib/admin/utils/time";

describe("date/timestamp normalization", () => {
  it("normalizes unix-second timestamps to milliseconds for date rendering", () => {
    const julyMs = Date.UTC(2026, 6, 4, 12, 0, 0, 0);
    const julySeconds = Math.floor(julyMs / 1000);

    assert.equal(timestampToIsoDate(julySeconds), "2026-07-04");
    assert.equal(
      formatDateLong({ timestamp: julySeconds }),
      formatDateLong({ timestamp: julyMs })
    );
    assert.match(formatDateTimeRange({ startTimestamp: julySeconds, endTimestamp: julySeconds + 3600 }), /2026/);
  });

  it("normalizes unix-second timestamps in shared time utilities", () => {
    const julyMs = Date.UTC(2026, 6, 4, 12, 0, 0, 0);
    const julySeconds = Math.floor(julyMs / 1000);
    const parsed = toDate(julySeconds);
    assert.ok(parsed);
    assert.equal(parsed!.getUTCFullYear(), 2026);
    assert.equal(parsed!.getUTCMonth(), 6);
    assert.equal(parsed!.getUTCDate(), 4);
  });

  it("prefers iso event date over conflicting timestamp when both are provided", () => {
    const iso = "2026-07-04";
    const conflictingTs = Date.UTC(2026, 8, 4, 12, 0, 0, 0); // Sep 4, 2026
    assert.equal(formatDateLong({ isoDate: iso, timestamp: conflictingTs }), "July 4, 2026");
  });

  it("preserves month/day for end-of-month dates like January 31", () => {
    const ts = parseDateToTimestamp("January 31, 2027");
    assert.ok(ts);
    assert.equal(timestampToIsoDate(ts), "2027-01-31");
    assert.equal(formatDateLong({ isoDate: "2027-01-31", timestamp: ts }), "January 31, 2027");
  });

  it("defaults yearless numeric dates to the current year", () => {
    const ts = parseDateToTimestamp("12/21");
    assert.ok(ts);
    const year = new Date().getFullYear();
    assert.equal(timestampToIsoDate(ts), `${year}-12-21`);
  });
});
