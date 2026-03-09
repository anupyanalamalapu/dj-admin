import { notFound } from "next/navigation";
import WorkspaceEditor from "@/components/admin/WorkspaceEditor";
import { getWorkspaceByEventId } from "@/lib/admin/orchestration/admin-service";

interface WorkspacePageProps {
  params: { eventId: string };
  searchParams?: { ocr?: string };
}

export default async function AdminWorkspacePage({ params, searchParams }: WorkspacePageProps) {
  const snapshot = await getWorkspaceByEventId(params.eventId);
  if (!snapshot) {
    notFound();
  }

  return <WorkspaceEditor initial={snapshot} ocrManualMode={searchParams?.ocr === "manual"} />;
}
