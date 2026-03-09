import { redirect } from "next/navigation";
import WorkspaceEditor from "@/components/admin/WorkspaceEditor";
import { getWorkspaceByEventId } from "@/lib/admin/orchestration/admin-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface WorkspacePageProps {
  params: { eventId: string };
  searchParams?: { ocr?: string };
}

export default async function AdminWorkspacePage({ params, searchParams }: WorkspacePageProps) {
  const snapshot = await getWorkspaceByEventId(params.eventId);
  if (!snapshot) {
    const query = new URLSearchParams({
      error: "workspace_not_found",
      eventId: params.eventId,
    });
    redirect(`/admin/inquiry?${query.toString()}`);
  }

  return <WorkspaceEditor initial={snapshot} ocrManualMode={searchParams?.ocr === "manual"} />;
}
