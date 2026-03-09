import { NextRequest, NextResponse } from "next/server";
import { requireAdminApiSession } from "@/lib/admin/auth/api-auth";
import { deleteWorkspace, getWorkspaceByEventId, updateWorkspace } from "@/lib/admin/orchestration/admin-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  request: NextRequest,
  context: { params: { eventId: string } }
): Promise<NextResponse> {
  const unauthorized = requireAdminApiSession(request);
  if (unauthorized) return unauthorized;

  const snapshot = await getWorkspaceByEventId(context.params.eventId);
  if (!snapshot) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }
  return NextResponse.json(snapshot);
}

export async function PATCH(
  request: NextRequest,
  context: { params: { eventId: string } }
): Promise<NextResponse> {
  const unauthorized = requireAdminApiSession(request);
  if (unauthorized) return unauthorized;

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  try {
    const { eventId: _ignoredEventId, ...payload } = body as Parameters<typeof updateWorkspace>[0];
    const snapshot = await updateWorkspace({
      eventId: context.params.eventId,
      ...payload,
    });

    if (!snapshot) {
      return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
    }

    return NextResponse.json(snapshot);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update workspace." },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: { eventId: string } }
): Promise<NextResponse> {
  const unauthorized = requireAdminApiSession(request);
  if (unauthorized) return unauthorized;

  try {
    const ok = await deleteWorkspace(context.params.eventId);
    if (!ok) {
      return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete workspace." },
      { status: 500 }
    );
  }
}
