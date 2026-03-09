import { NextRequest, NextResponse } from "next/server";
import { requireAdminApiSession } from "@/lib/admin/auth/api-auth";
import { getBootstrapStatus } from "@/lib/admin/auth/session";
import { getRuntimeConfigDiagnostics } from "@/lib/admin/config/runtime-config";
import { getAdminDataRoot } from "@/lib/admin/persistence/paths";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const unauthorized = await requireAdminApiSession(request);
  if (unauthorized) return unauthorized;

  const bootstrap = await getBootstrapStatus();
  const diagnostics = getRuntimeConfigDiagnostics();

  return NextResponse.json({
    valid: diagnostics.valid,
    auth: {
      bootstrapped: !bootstrap.needsBootstrap,
      needsBootstrap: bootstrap.needsBootstrap,
      bootstrapTokenConfigured: diagnostics.auth.bootstrapTokenConfigured,
      sessionSecretConfigured: diagnostics.auth.sessionSecretConfigured,
      sessionSecretStrong: diagnostics.auth.sessionSecretStrong,
      storageBackend: diagnostics.auth.storageBackend,
      runtimeDataBackend: diagnostics.auth.runtimeDataBackend,
      dataRoot: getAdminDataRoot(),
    },
    ai: {
      enabled: diagnostics.ai.enabled,
      apiKeyConfigured: diagnostics.ai.apiKeyConfigured,
      ocrEnabled: diagnostics.ai.ocrEnabled,
      modelsConfigured: diagnostics.ai.modelsConfigured,
    },
    errors: diagnostics.errors,
    warnings: diagnostics.warnings,
  });
}
