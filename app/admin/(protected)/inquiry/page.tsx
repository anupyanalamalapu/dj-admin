import InquiryIngestForm from "@/components/admin/InquiryIngestForm";
import { listWorkspaces } from "@/lib/admin/orchestration/admin-service";

export default async function AdminInquiryPage() {
  const workspaces = await listWorkspaces();
  const workspaceOptions = workspaces.map((workspace) => ({
    eventId: workspace.eventId,
    label: workspace.workspaceTitle || `${workspace.clientName} - ${workspace.eventType || "Event"}`,
    contact: workspace.primaryContact || workspace.clientEmail,
  }));

  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-white">Context Intake</h1>
        <p className="mt-1 text-sm text-slate-300">
          Paste or upload new client context to create or update a workspace.
        </p>
      </div>
      <InquiryIngestForm workspaceOptions={workspaceOptions} />
    </section>
  );
}
