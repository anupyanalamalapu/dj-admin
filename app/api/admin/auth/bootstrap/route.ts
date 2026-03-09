import { NextRequest, NextResponse } from "next/server";
import { bootstrapAdminUser, getBootstrapStatus } from "@/lib/admin/auth/session";
import { validateAuthRuntimeConfig } from "@/lib/admin/config/runtime-config";

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await getBootstrapStatus());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load bootstrap status." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authConfigErrors = validateAuthRuntimeConfig().errors;
  if (authConfigErrors.length > 0) {
    return NextResponse.json({ error: authConfigErrors.join(" ") }, { status: 500 });
  }

  let bootstrapToken = (request.headers.get("x-admin-bootstrap-token") || "").trim();
  let username = "";
  let password = "";
  try {
    const body = (await request.json()) as {
      bootstrapToken?: string;
      username?: string;
      password?: string;
    };
    if (!bootstrapToken) {
      bootstrapToken = (body.bootstrapToken || "").trim();
    }
    username = (body.username || "").trim();
    password = body.password || "";
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  try {
    const result = await bootstrapAdminUser({
      bootstrapToken,
      username,
      password,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error || "Bootstrap failed." }, { status: result.status });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Bootstrap failed." },
      { status: 500 },
    );
  }
}
