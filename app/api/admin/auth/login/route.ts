import { NextRequest, NextResponse } from "next/server";
import {
  authenticateAdminCredentials,
  createSessionToken,
  getCookieName,
  getSessionCookieOptions,
} from "@/lib/admin/auth/session";
import { validateAuthRuntimeConfig } from "@/lib/admin/config/runtime-config";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authConfigErrors = validateAuthRuntimeConfig().errors;
  if (authConfigErrors.length > 0) {
    return NextResponse.json({ error: authConfigErrors.join(" ") }, { status: 500 });
  }

  let username = "";
  let password = "";

  try {
    const body = (await request.json()) as { username?: string; password?: string };
    username = (body.username || "").trim();
    password = body.password || "";
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const auth = authenticateAdminCredentials(username, password, {
    ip: request.headers.get("x-forwarded-for") || request.ip || "",
    userAgent: request.headers.get("user-agent") || "",
  });
  if (!auth.ok || !auth.user) {
    const response = NextResponse.json(
      {
        error: auth.error || "Invalid username or password.",
        retryAfter: auth.retryAfter,
        retryAfterSeconds: auth.retryAfterSeconds,
      },
      { status: auth.status || 401 },
    );
    if ((auth.status || 0) === 429 && auth.retryAfter) {
      response.headers.set("Retry-After", String(auth.retryAfter));
    }
    return response;
  }

  try {
    const token = createSessionToken(auth.user, {
      ip: request.headers.get("x-forwarded-for") || request.ip || "",
      userAgent: request.headers.get("user-agent") || "",
    });

    const response = NextResponse.json({ ok: true, username: auth.user.username });
    response.cookies.set({
      name: getCookieName(),
      value: token,
      ...getSessionCookieOptions(),
    });

    return response;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Auth session configuration is invalid." },
      { status: 500 },
    );
  }
}
