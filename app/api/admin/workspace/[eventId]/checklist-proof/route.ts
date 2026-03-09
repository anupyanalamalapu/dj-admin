import { NextRequest, NextResponse } from "next/server";
import { uploadWorkspaceChecklistProof } from "@/lib/admin/orchestration/admin-service";
import type { ChecklistProofKind } from "@/lib/admin/orchestration/admin-service";
import { requireAdminApiSession } from "@/lib/admin/auth/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const VALID_KINDS: ChecklistProofKind[] = ["signed_contract", "deposit_proof", "invoice_proof"];

export async function POST(request: NextRequest, context: { params: { eventId: string } }) {
  try {
    const unauthorized = await requireAdminApiSession(request);
    if (unauthorized) return unauthorized;

    const formData = await request.formData();
    const kind = formData.get("kind")?.toString() as ChecklistProofKind | undefined;
    const maybeFile = formData.get("upload");
    const uploadFile = maybeFile instanceof File ? maybeFile : null;

    if (!kind || !VALID_KINDS.includes(kind)) {
      return NextResponse.json({ error: "Invalid checklist proof type." }, { status: 400 });
    }
    if (!uploadFile) {
      return NextResponse.json({ error: "Upload a file before submitting." }, { status: 400 });
    }

    const result = await uploadWorkspaceChecklistProof({
      eventId: context.params.eventId,
      kind,
      file: uploadFile,
    });

    if (!result) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to upload checklist proof.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
