import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/admin/auth/guard";

export default async function AdminIndexPage() {
  const session = await getAdminSession();
  if (session) {
    redirect("/admin/inquiry");
  }
  redirect("/admin/login");
}
