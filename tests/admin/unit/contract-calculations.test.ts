import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculateTotals } from "../../../lib/admin/contracts/calc";

describe("calculateTotals", () => {
  it("computes total, 25% deposit, and remainder", () => {
    const result = calculateTotals(
      [
        { id: "1", label: "Sangeet", amount: 2400 },
        { id: "2", label: "Reception", amount: 3600 },
      ],
      1000
    );

    assert.equal(result.totalAmount, 7000);
    assert.equal(result.depositAmount, 1750);
    assert.equal(result.remainingAmount, 5250);
  });
});
