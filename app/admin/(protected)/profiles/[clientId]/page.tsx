import { redirect } from "next/navigation";
import { getProfileByClientId } from "@/lib/admin/orchestration/admin-service";

interface ProfilePageProps {
  params: { clientId: string };
}

export default async function AdminProfilePage({ params }: ProfilePageProps) {
  const profile = await getProfileByClientId(params.clientId);
  if (!profile || profile.events.length === 0) {
    redirect("/admin/workspaces");
  }

  const latestEvent = [...profile.events].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  redirect(`/admin/workspace/${latestEvent.id}`);
}
