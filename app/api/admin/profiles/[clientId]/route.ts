import { NextRequest, NextResponse } from "next/server";
import { requireAdminApiSession } from "@/lib/admin/auth/api-auth";
import { getProfileByClientId } from "@/lib/admin/orchestration/admin-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  request: NextRequest,
  context: { params: { clientId: string } }
): Promise<NextResponse> {
  const unauthorized = await requireAdminApiSession(request);
  if (unauthorized) return unauthorized;

  const profile = await getProfileByClientId(context.params.clientId);
  if (!profile) {
    return NextResponse.json({ error: "Profile not found." }, { status: 404 });
  }

  return NextResponse.json(profile);
}
