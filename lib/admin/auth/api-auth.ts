import { NextRequest, NextResponse } from "next/server";
import { getCookieName, verifySessionToken } from "./session";

export async function requireAdminApiSession(request: NextRequest): Promise<NextResponse | null> {
  const token = request.cookies.get(getCookieName())?.value;
  const session = await verifySessionToken(token);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
