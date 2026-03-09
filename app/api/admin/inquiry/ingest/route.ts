import { NextRequest, NextResponse } from "next/server";
import { ingestInquiry } from "@/lib/admin/orchestration/admin-service";
import { ensureAdminDataLayout } from "@/lib/admin/persistence/store";
import { requireAdminApiSession } from "@/lib/admin/auth/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: NextRequest) {
  try {
    const unauthorized = requireAdminApiSession(request);
    if (unauthorized) return unauthorized;

    await ensureAdminDataLayout();
    const formData = await request.formData();
    let messageText = (formData.get("messageText")?.toString() || "").trim();
    let workspaceEventId = (formData.get("workspaceEventId")?.toString() || "").trim();
    const manualEmail = (formData.get("manualEmail")?.toString() || "").trim();
    const manualPhone = (formData.get("manualPhone")?.toString() || "").trim();
    const manualInstagramHandle = (formData.get("manualInstagramHandle")?.toString() || "").trim();
    const embeddedWorkspaceId = messageText.match(/\[\[WORKSPACE_EVENT_ID:([a-zA-Z0-9_-]+)\]\]/)?.[1];
    if (!workspaceEventId && embeddedWorkspaceId) {
      workspaceEventId = embeddedWorkspaceId.trim();
    }
    messageText = messageText.replace(/\[\[WORKSPACE_EVENT_ID:[a-zA-Z0-9_-]+\]\]/g, "").trim();
    const maybeFile = formData.get("upload");
    const uploadFile = maybeFile instanceof File ? maybeFile : null;

    if (!messageText && !uploadFile) {
      return NextResponse.json({ error: "Provide inquiry text or an uploaded file." }, { status: 400 });
    }

    const result = await ingestInquiry({
      messageText,
      uploadedFile: uploadFile,
      targetEventId: workspaceEventId || undefined,
      manualContact: {
        email: manualEmail || undefined,
        phone: manualPhone || undefined,
        instagramHandle: manualInstagramHandle || undefined,
      },
    });

    return NextResponse.json({
      ok: true,
      eventId: result.eventId,
      clientId: result.clientId,
      ocrStatus: result.ocrStatus,
      ocrReason: result.ocrReason,
    });
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "Failed to process inquiry.";
    const isValidationError =
      /requires at least one contact/i.test(message) ||
      /workspace creation was blocked/i.test(message) ||
      /selected workspace was not found/i.test(message) ||
      /provide inquiry text or an uploaded file/i.test(message);
    return NextResponse.json({ error: message }, { status: isValidationError ? 400 : 500 });
  }
}
