type CodexService = "extract" | "match" | "email" | "amendment" | "summary";

export interface AdminAuthEnvConfig {
  bootstrapToken: string;
  sessionSecret: string;
}

export interface AdminAiModelsConfig {
  global: string;
  extract: string;
  match: string;
  email: string;
  amendment: string;
  summary: string;
  ocr: string;
}

export interface AdminAiEnvConfig {
  enabled: boolean;
  ocrEnabled: boolean;
  apiKey: string;
  models: AdminAiModelsConfig;
}

export interface RuntimeConfigValidation {
  errors: string[];
  warnings: string[];
}

export interface RuntimeConfigDiagnostics {
  valid: boolean;
  errors: string[];
  warnings: string[];
  auth: {
    bootstrapTokenConfigured: boolean;
    bootstrapTokenStrong: boolean;
    sessionSecretConfigured: boolean;
    sessionSecretStrong: boolean;
  };
  ai: {
    enabled: boolean;
    apiKeyConfigured: boolean;
    ocrEnabled: boolean;
    modelsConfigured: {
      extract: boolean;
      match: boolean;
      email: boolean;
      amendment: boolean;
      summary: boolean;
      ocr: boolean;
    };
  };
}

const DEFAULT_MODELS: Record<CodexService, string> = {
  extract: "codex-5.3",
  match: "gpt-4.1-mini",
  email: "codex-5.3",
  amendment: "gpt-4.1-mini",
  summary: "gpt-4.1-mini",
};

function readEnv(name: string): string {
  return (process.env[name] || "").trim();
}

function parseBoolean(raw: string, fallback: boolean): boolean {
  const value = raw.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

export function getAdminAuthEnvConfig(): AdminAuthEnvConfig {
  return {
    bootstrapToken: readEnv("ADMIN_BOOTSTRAP_TOKEN"),
    sessionSecret: readEnv("ADMIN_SESSION_SECRET"),
  };
}

export function getAdminAiEnvConfig(): AdminAiEnvConfig {
  const apiKey = readEnv("OPENAI_API_KEY");
  const global = readEnv("ADMIN_CODEX_MODEL");
  const extract = readEnv("ADMIN_CODEX_MODEL_EXTRACT");
  const match = readEnv("ADMIN_CODEX_MODEL_MATCH");
  const email = readEnv("ADMIN_CODEX_MODEL_EMAIL");
  const amendment = readEnv("ADMIN_CODEX_MODEL_AMENDMENT");
  const summary = readEnv("ADMIN_CODEX_MODEL_SUMMARY");
  const ocr = readEnv("ADMIN_CODEX_MODEL_OCR");

  return {
    enabled: parseBoolean(readEnv("ADMIN_ENABLE_CODEX_AI"), false),
    ocrEnabled: parseBoolean(readEnv("ADMIN_ENABLE_AI_OCR"), Boolean(apiKey)),
    apiKey,
    models: {
      global,
      extract: extract || global || DEFAULT_MODELS.extract,
      match: match || global || DEFAULT_MODELS.match,
      email: email || global || DEFAULT_MODELS.email,
      amendment: amendment || global || DEFAULT_MODELS.amendment,
      summary: summary || extract || global || DEFAULT_MODELS.summary,
      ocr: ocr || extract || global || DEFAULT_MODELS.match,
    },
  };
}

export function validateRuntimeConfig(): RuntimeConfigValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  const authValidation = validateAuthRuntimeConfig();
  errors.push(...authValidation.errors);
  warnings.push(...authValidation.warnings);

  const aiValidation = validateAiRuntimeConfig();
  errors.push(...aiValidation.errors);
  warnings.push(...aiValidation.warnings);

  return { errors, warnings };
}

export function validateAuthRuntimeConfig(): RuntimeConfigValidation {
  const auth = getAdminAuthEnvConfig();
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!auth.sessionSecret) {
    errors.push("ADMIN_SESSION_SECRET is required.");
  } else if (auth.sessionSecret.length < 32) {
    errors.push("ADMIN_SESSION_SECRET must be at least 32 characters.");
  }

  if (auth.bootstrapToken && auth.bootstrapToken.length < 16) {
    warnings.push("ADMIN_BOOTSTRAP_TOKEN should be at least 16 characters.");
  }

  return { errors, warnings };
}

export function validateAiRuntimeConfig(): RuntimeConfigValidation {
  const ai = getAdminAiEnvConfig();
  const errors: string[] = [];
  const warnings: string[] = [];

  if (ai.enabled && !ai.apiKey) {
    errors.push("OPENAI_API_KEY is required when ADMIN_ENABLE_CODEX_AI=true.");
  }

  if (ai.ocrEnabled && !ai.apiKey) {
    errors.push("OPENAI_API_KEY is required when ADMIN_ENABLE_AI_OCR=true.");
  }

  if (ai.apiKey && !/^sk-[A-Za-z0-9]/.test(ai.apiKey)) {
    warnings.push("OPENAI_API_KEY format looks unusual (expected to start with 'sk-').");
  }

  return { errors, warnings };
}

export function getRuntimeConfigDiagnostics(): RuntimeConfigDiagnostics {
  const auth = getAdminAuthEnvConfig();
  const ai = getAdminAiEnvConfig();
  const validation = validateRuntimeConfig();

  const diagnostics: RuntimeConfigDiagnostics = {
    valid: validation.errors.length === 0,
    errors: validation.errors,
    warnings: validation.warnings,
    auth: {
      bootstrapTokenConfigured: Boolean(auth.bootstrapToken),
      bootstrapTokenStrong: auth.bootstrapToken.length >= 16,
      sessionSecretConfigured: Boolean(auth.sessionSecret),
      sessionSecretStrong: auth.sessionSecret.length >= 32,
    },
    ai: {
      enabled: ai.enabled,
      apiKeyConfigured: Boolean(ai.apiKey),
      ocrEnabled: ai.ocrEnabled,
      modelsConfigured: {
        extract: Boolean(ai.models.extract),
        match: Boolean(ai.models.match),
        email: Boolean(ai.models.email),
        amendment: Boolean(ai.models.amendment),
        summary: Boolean(ai.models.summary),
        ocr: Boolean(ai.models.ocr),
      },
    },
  };

  return diagnostics;
}
