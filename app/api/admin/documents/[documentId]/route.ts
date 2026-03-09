import { NextRequest, NextResponse } from "next/server";
import { requireAdminApiSession } from "@/lib/admin/auth/api-auth";
import { readStoredFile } from "@/lib/admin/persistence/files";
import { readStore } from "@/lib/admin/persistence/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

function contentDisposition(filename: string): string {
  const safe = (filename || "document")
    .replace(/[/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  const encoded = encodeURIComponent(safe);
  return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

export async function GET(
  request: NextRequest,
  context: { params: { documentId: string } }
): Promise<NextResponse> {
  const unauthorized = await requireAdminApiSession(request);
  if (unauthorized) return unauthorized;

  const store = await readStore();
  const doc = store.documents.find((item) => item.id === context.params.documentId);
  if (!doc) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }
  if (!doc.storedPath) {
    return NextResponse.json({ error: "Document path is unavailable." }, { status: 404 });
  }

  const stored = await readStoredFile(doc.storedPath);
  if (!stored) {
    return NextResponse.json({ error: "Document file could not be read." }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(stored.bytes), {
    status: 200,
    headers: {
      "Content-Type": doc.mimeType || stored.mimeType || "application/octet-stream",
      "Content-Disposition": contentDisposition(doc.filename),
      "Cache-Control": "no-store",
    },
  });
}
