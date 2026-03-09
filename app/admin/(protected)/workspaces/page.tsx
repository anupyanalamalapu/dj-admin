import WorkspacesTable from "@/components/admin/WorkspacesTable";
import { listWorkspaces } from "@/lib/admin/orchestration/admin-service";

export default async function AdminWorkspacesPage() {
  const workspaces = await listWorkspaces();

  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-white">Workspaces</h1>
        <p className="mt-1 text-sm text-slate-300">Review all active relationships and open the workspace to edit details.</p>
      </div>
      <WorkspacesTable initialWorkspaces={workspaces} />
    </section>
  );
}
