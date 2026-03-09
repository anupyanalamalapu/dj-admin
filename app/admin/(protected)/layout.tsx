import { ReactNode } from "react";
import { redirect } from "next/navigation";
import AdminNav from "@/components/admin/AdminNav";
import { getAdminSession } from "@/lib/admin/auth/guard";

export default async function AdminProtectedLayout({ children }: { children: ReactNode }) {
  const session = getAdminSession();
  if (!session) {
    redirect("/admin/login");
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(59,130,246,0.2),_transparent_45%),radial-gradient(circle_at_bottom,_rgba(139,92,246,0.14),_transparent_40%),#050509]">
      <AdminNav username={session.username} />
      <div className="mx-auto w-full max-w-7xl px-4 py-6">{children}</div>
    </main>
  );
}
