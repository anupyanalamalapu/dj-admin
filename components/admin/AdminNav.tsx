"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

const LINKS = [
  { href: "/admin/inquiry", label: "Context", matchPrefixes: ["/admin/inquiry"] },
  { href: "/admin/workspaces", label: "Workspaces", matchPrefixes: ["/admin/workspaces", "/admin/workspace/"] },
];

export default function AdminNav({ username }: { username: string }) {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch("/api/admin/auth/logout", { method: "POST" });
    router.push("/admin/login");
    router.refresh();
  }

  return (
    <header className="border-b border-white/10 bg-black/30 backdrop-blur">
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-4 py-3">
        <div className="flex items-center gap-5">
          <Link href="/admin/inquiry" className="text-sm font-semibold text-white">
            DJ Admin
          </Link>
          <nav className="flex items-center gap-3">
            {LINKS.map((link) => {
              const active = link.matchPrefixes.some((prefix) => pathname.startsWith(prefix));
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`rounded px-2 py-1 text-sm ${
                    active ? "bg-blue-500/20 text-blue-100" : "text-slate-300 hover:bg-white/10"
                  }`}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-300">{username}</span>
          <button
            onClick={logout}
            className="rounded border border-white/20 px-2 py-1 text-xs text-slate-100 hover:bg-white/10"
          >
            Logout
          </button>
        </div>
      </div>
    </header>
  );
}
