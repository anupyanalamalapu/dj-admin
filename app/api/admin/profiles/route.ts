import { NextRequest, NextResponse } from "next/server";
import { listProfiles } from "@/lib/admin/orchestration/profile-service";
import { requireAdminApiSession } from "@/lib/admin/auth/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: NextRequest) {
  const unauthorized = await requireAdminApiSession(request);
  if (unauthorized) return unauthorized;

  const profiles = await listProfiles();
  return NextResponse.json({ profiles });
}
