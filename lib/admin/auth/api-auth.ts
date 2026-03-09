import { NextRequest, NextResponse } from "next/server";
import { getCookieName, verifySessionToken } from "./session";

export function requireAdminApiSession(request: NextRequest): NextResponse | null {
  const token = request.cookies.get(getCookieName())?.value;
  const session = verifySessionToken(token);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
