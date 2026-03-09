import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getSessionCookieOptions, getSessionTtlSeconds } from "../../../lib/admin/auth/session";

describe("auth cookie options", () => {
  it("uses strict cookie settings in production", () => {
    process.env.NODE_ENV = "production";
    const options = getSessionCookieOptions();
    assert.equal(options.httpOnly, true);
    assert.equal(options.sameSite, "strict");
    assert.equal(options.secure, true);
    assert.equal(options.path, "/");
    assert.equal(options.maxAge, getSessionTtlSeconds());
  });

  it("keeps secure=false outside production", () => {
    process.env.NODE_ENV = "development";
    const options = getSessionCookieOptions();
    assert.equal(options.secure, false);
    assert.equal(options.sameSite, "strict");
  });
});
