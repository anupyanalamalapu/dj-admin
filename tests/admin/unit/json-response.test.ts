import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseJsonResponseSafe } from "../../../lib/admin/http/json-response";

describe("parseJsonResponseSafe", () => {
  it("parses valid JSON payload", async () => {
    const response = new Response(JSON.stringify({ eventId: "event_1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const parsed = await parseJsonResponseSafe<{ eventId: string }>(response);
    assert.equal(parsed.data?.eventId, "event_1");
    assert.equal(parsed.error, undefined);
  });

  it("returns parse error for non-JSON payload", async () => {
    const response = new Response("<html>server error</html>", {
      status: 500,
      headers: { "content-type": "text/html" },
    });

    const parsed = await parseJsonResponseSafe<{ error?: string }>(response);
    assert.equal(parsed.data, undefined);
    assert.equal(parsed.error, "Response body was not valid JSON");
    assert.match(parsed.rawText, /server error/i);
  });

  it("returns error for empty body", async () => {
    const response = new Response("", { status: 500 });
    const parsed = await parseJsonResponseSafe<{ error?: string }>(response);
    assert.equal(parsed.data, undefined);
    assert.equal(parsed.error, "Empty response body");
  });
});
