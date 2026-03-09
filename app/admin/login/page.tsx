"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface JsonPayload {
  error?: string;
  retryAfterSeconds?: number;
  needsBootstrap?: boolean;
  ok?: boolean;
}

async function parseJsonResponse(response: Response): Promise<JsonPayload> {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (!contentType.includes("application/json") || !text) {
    return {};
  }
  try {
    return JSON.parse(text) as JsonPayload;
  } catch {
    return {};
  }
}

export default function AdminLoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const [checkingBootstrap, setCheckingBootstrap] = useState(true);
  const [needsBootstrap, setNeedsBootstrap] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadBootstrapState() {
      try {
        const response = await fetch("/api/admin/auth/bootstrap", { cache: "no-store" });
        const payload = await parseJsonResponse(response);
        if (cancelled) return;
        if (response.ok) {
          setNeedsBootstrap(Boolean(payload.needsBootstrap));
        } else {
          setNeedsBootstrap(false);
        }
      } finally {
        if (!cancelled) {
          setCheckingBootstrap(false);
        }
      }
    }
    loadBootstrapState();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/admin/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const payload = await parseJsonResponse(response);

      if (!response.ok) {
        if (response.status === 409) {
          setNeedsBootstrap(true);
        }
        if (response.status === 429 && payload.retryAfterSeconds) {
          setError(`Too many failed attempts. Try again in ${payload.retryAfterSeconds}s.`);
        } else {
          setError(payload.error || "Login failed");
        }
        return;
      }

      router.push("/admin/inquiry");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top,_rgba(59,130,246,0.25),_transparent_45%),radial-gradient(circle_at_bottom,_rgba(139,92,246,0.18),_transparent_40%),#050509] px-4 py-8">
      <div className="w-full max-w-md rounded-xl border border-white/15 bg-white/5 p-6 shadow-sm backdrop-blur">
        <h1 className="text-xl font-semibold text-white">Admin Login</h1>
        <p className="mt-2 text-sm text-slate-300">
          Use your admin account credentials. Passwords are stored as secure hashes in auth storage.
        </p>

        {checkingBootstrap ? (
          <p className="mt-4 text-sm text-slate-300">Checking auth setup...</p>
        ) : null}

        {!checkingBootstrap && needsBootstrap ? (
          <section className="mt-6 space-y-4">
            <h2 className="text-sm font-semibold text-white">First-time bootstrap</h2>
            <p className="rounded border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-sm text-amber-200">
              No admin account exists yet. Run one trusted bootstrap request from terminal using
              `X-Admin-Bootstrap-Token`, then return here to log in.
            </p>
            <p className="text-xs text-slate-300">
              POST /api/admin/auth/bootstrap with JSON body {"{ \"username\": \"admin\", \"password\": \"...\" }"} and
              header `x-admin-bootstrap-token`.
            </p>
          </section>
        ) : (
          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            <label className="block text-sm text-slate-200">
              Username
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="mt-1 w-full rounded-md border border-white/20 bg-slate-900 px-3 py-2 text-white placeholder:text-slate-400"
                autoComplete="username"
              />
            </label>

            <label className="block text-sm text-slate-200">
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full rounded-md border border-white/20 bg-slate-900 px-3 py-2 text-white placeholder:text-slate-400"
                autoComplete="current-password"
              />
            </label>

            {error ? <p className="text-sm text-rose-300">{error}</p> : null}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? "Signing in..." : "Sign in"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
