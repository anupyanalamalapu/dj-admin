import { NextRequest, NextResponse } from "next/server";
import { getCookieName, getSessionCookieOptions, revokeSessionToken } from "@/lib/admin/auth/session";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get(getCookieName())?.value;
  await revokeSessionToken(token);

  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: getCookieName(),
    value: "",
    ...getSessionCookieOptions(),
    maxAge: 0,
    expires: new Date(0),
  });
  return response;
}
