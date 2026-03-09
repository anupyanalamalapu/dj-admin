import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getRuntimeConfigDiagnostics,
  validateAiRuntimeConfig,
  validateAuthRuntimeConfig,
} from "../../../lib/admin/config/runtime-config";

describe("runtime config validator", () => {
  it("fails when session secret is missing or too short", () => {
    process.env.ADMIN_SESSION_SECRET = "";
    let validation = validateAuthRuntimeConfig();
    assert.ok(validation.errors.some((item) => item.includes("ADMIN_SESSION_SECRET is required")));

    process.env.ADMIN_SESSION_SECRET = "short-secret";
    validation = validateAuthRuntimeConfig();
    assert.ok(validation.errors.some((item) => item.includes("at least 32")));
  });

  it("requires OPENAI_API_KEY when AI is enabled", () => {
    process.env.ADMIN_ENABLE_CODEX_AI = "true";
    process.env.OPENAI_API_KEY = "";
    const aiValidation = validateAiRuntimeConfig();
    assert.ok(aiValidation.errors.some((item) => item.includes("OPENAI_API_KEY")));
  });

  it("returns healthy diagnostics for valid config", () => {
    process.env.ADMIN_BOOTSTRAP_TOKEN = "bootstrap-token-1234567890";
    process.env.ADMIN_SESSION_SECRET = "session-secret-1234567890-abcdefghij";
    process.env.ADMIN_ENABLE_CODEX_AI = "true";
    process.env.OPENAI_API_KEY = "sk-test123";
    process.env.ADMIN_CODEX_MODEL_EXTRACT = "gpt-4.1-mini";
    process.env.ADMIN_CODEX_MODEL_MATCH = "gpt-4.1-mini";
    process.env.ADMIN_CODEX_MODEL_EMAIL = "gpt-4.1";
    process.env.ADMIN_CODEX_MODEL_AMENDMENT = "gpt-4.1";
    process.env.ADMIN_CODEX_MODEL_SUMMARY = "gpt-4.1-mini";
    process.env.ADMIN_ENABLE_AI_OCR = "true";
    process.env.ADMIN_CODEX_MODEL_OCR = "gpt-4.1-mini";

    const diagnostics = getRuntimeConfigDiagnostics();
    assert.equal(diagnostics.valid, true);
    assert.equal(diagnostics.auth.bootstrapTokenConfigured, true);
    assert.equal(diagnostics.auth.sessionSecretConfigured, true);
    assert.equal(diagnostics.ai.enabled, true);
    assert.equal(diagnostics.ai.apiKeyConfigured, true);
    assert.equal(diagnostics.ai.modelsConfigured.extract, true);
    assert.equal(diagnostics.ai.modelsConfigured.email, true);
    assert.equal(diagnostics.ai.modelsConfigured.ocr, true);
  });
});
