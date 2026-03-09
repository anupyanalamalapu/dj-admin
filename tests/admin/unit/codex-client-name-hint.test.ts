import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveClientNameFromHints } from "../../../lib/admin/ai/codex-sdk";

describe("resolveClientNameFromHints", () => {
  it("prefers signature name hint over AI/header aliases", () => {
    const resolved = resolveClientNameFromHints({
      aiClientName: "anjali parth",
      fallbackClientName: "Anjali Parth",
      signatureNameHint: "Anjali Trivedi",
      senderNameHint: "Anjali Parth",
    });

    assert.equal(resolved, "Anjali Trivedi");
  });

  it("falls back to AI/fallback/sender when signature is missing", () => {
    const resolved = resolveClientNameFromHints({
      aiClientName: "gaby rivera",
      fallbackClientName: "Gaby",
      senderNameHint: "Gaby Rivera",
    });

    assert.equal(resolved, "Gaby Rivera");
  });

  it("avoids using internal owner signature over recipient hint for text-message style context", () => {
    const resolved = resolveClientNameFromHints({
      aiClientName: "delivered",
      fallbackClientName: "Nitya Devireddy",
      signatureNameHint: "Anupya Nalamalapu",
      senderNameHint: "Nitya Devireddy",
    });

    assert.equal(resolved, "Nitya Devireddy");
  });
});
