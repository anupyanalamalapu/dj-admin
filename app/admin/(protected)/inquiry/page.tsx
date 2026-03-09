import InquiryIngestForm from "@/components/admin/InquiryIngestForm";
import { listWorkspaces } from "@/lib/admin/orchestration/admin-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface AdminInquiryPageProps {
  searchParams?: {
    error?: string;
    eventId?: string;
  };
}

function errorFromSearchParams(searchParams?: { error?: string; eventId?: string }): string {
  if (searchParams?.error === "workspace_not_found") {
    const eventId = (searchParams.eventId || "").trim();
    return eventId
      ? `Workspace ${eventId} was not found. Context was saved; select an existing workspace or reprocess this inquiry.`
      : "Workspace was not found. Context was saved; select an existing workspace or reprocess this inquiry.";
  }
  return "";
}

export default async function AdminInquiryPage({ searchParams }: AdminInquiryPageProps) {
  const workspaces = await listWorkspaces();
  const workspaceOptions = workspaces.map((workspace) => ({
    eventId: workspace.eventId,
    label: workspace.workspaceTitle || `${workspace.clientName} - ${workspace.eventType || "Event"}`,
    contact: workspace.primaryContact || workspace.clientEmail,
  }));

  const initialError = errorFromSearchParams(searchParams);

  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-white">Context Intake</h1>
        <p className="mt-1 text-sm text-slate-300">
          Paste or upload new client context to create or update a workspace.
        </p>
      </div>
      <InquiryIngestForm workspaceOptions={workspaceOptions} initialError={initialError} />
    </section>
  );
}
