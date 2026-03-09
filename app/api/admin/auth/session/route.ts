import { NextRequest, NextResponse } from "next/server";
import { getCookieName, getSessionCookieOptions, verifySessionToken } from "@/lib/admin/auth/session";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get(getCookieName())?.value;
  const session = verifySessionToken(token);

  if (!session) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  const response = NextResponse.json({ authenticated: true, username: session.username });
  if (token) {
    response.cookies.set({
      name: getCookieName(),
      value: token,
      ...getSessionCookieOptions(),
    });
  }
  return response;
}
