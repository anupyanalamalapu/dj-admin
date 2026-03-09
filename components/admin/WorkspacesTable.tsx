"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { WorkspaceListItem } from "@/lib/admin/types/models";
import { formatDateShort, parseDateToTimestamp } from "@/lib/admin/utils/date";

interface WorkspacesTableProps {
  initialWorkspaces: WorkspaceListItem[];
}

export default function WorkspacesTable({ initialWorkspaces }: WorkspacesTableProps) {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState(initialWorkspaces);
  const [deletingEventId, setDeletingEventId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [sortKey, setSortKey] = useState<
    "client" | "contact" | "stage" | "eventType" | "when" | "venue" | "workspaceSummary" | "contractTotal" | "lastModified"
  >("lastModified");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");

  function stageChip(workspace: WorkspaceListItem): { label: "Inquiry" | "In Contract" | "Upcoming" | "Cancelled" | "Complete"; className: string } {
    const now = Date.now();
    const canonicalEventDateTs = parseDateToTimestamp(workspace.eventDate) || workspace.eventDateTimestamp;
    const startTs = workspace.workspaceStartTimestamp || canonicalEventDateTs;
    const endTs = workspace.workspaceEndTimestamp;
    const signed = workspace.signedContract;
    const deposit = workspace.initialDepositReceived;
    const fullyPaid = workspace.invoiceStatus === "paid";
    const nowDate = new Date(now);

    if (workspace.status === "cancelled") {
      return {
        label: "Cancelled",
        className: "bg-rose-100 text-rose-800 border-rose-200",
      };
    }

    if (signed && deposit && fullyPaid && typeof endTs === "number" && endTs <= now) {
      return {
        label: "Complete",
        className: "bg-emerald-100 text-emerald-800 border-emerald-200",
      };
    }

    if (signed && deposit) {
      if (typeof startTs === "number") {
        const startDate = new Date(startTs);
        const sameCalendarMonth =
          startDate.getFullYear() === nowDate.getFullYear() &&
          startDate.getMonth() === nowDate.getMonth();
        if (startTs >= now && sameCalendarMonth) {
          return {
            label: "Upcoming",
            className: "bg-indigo-100 text-indigo-800 border-indigo-200",
          };
        }
      }
      return {
        label: "In Contract",
        className: "bg-blue-100 text-blue-800 border-blue-200",
      };
    }

    return {
      label: "Inquiry",
      className: "bg-amber-100 text-amber-800 border-amber-200",
    };
  }

  async function handleDelete(eventId: string) {
    const confirmed = window.confirm("Delete this workspace and all related context/contract/invoice data?");
    if (!confirmed) return;

    setDeletingEventId(eventId);
    setStatus("");
    try {
      const response = await fetch(`/api/admin/workspace/${eventId}`, { method: "DELETE" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setStatus(payload.error || "Failed to delete workspace.");
        return;
      }
      setWorkspaces((previous) => previous.filter((workspace) => workspace.eventId !== eventId));
      setStatus("Workspace deleted.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to delete workspace.");
    } finally {
      setDeletingEventId(null);
    }
  }

  function contactForRow(workspace: WorkspaceListItem): string {
    return workspace.primaryContact || workspace.clientEmail || workspace.clientPhone || workspace.clientInstagramHandle || "-";
  }

  function whenTimestampForSort(workspace: WorkspaceListItem): number {
    return (
      workspace.workspaceStartTimestamp ||
      parseDateToTimestamp(workspace.eventDate) ||
      workspace.eventDateTimestamp ||
      0
    );
  }

  function formatDateOnlyRange(startTimestamp?: number, endTimestamp?: number, fallback?: string): string {
    if (typeof startTimestamp !== "number") {
      return fallback || "-";
    }

    const start = new Date(startTimestamp);
    if (Number.isNaN(start.getTime())) {
      return fallback || "-";
    }

    if (typeof endTimestamp !== "number") {
      return new Intl.DateTimeFormat("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      }).format(start);
    }

    const end = new Date(endTimestamp);
    if (Number.isNaN(end.getTime())) {
      return new Intl.DateTimeFormat("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      }).format(start);
    }

    const sameYear = start.getFullYear() === end.getFullYear();
    const sameMonth = sameYear && start.getMonth() === end.getMonth();
    const sameDay = sameMonth && start.getDate() === end.getDate();

    if (sameDay) {
      return new Intl.DateTimeFormat("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      }).format(start);
    }

    if (sameMonth) {
      const month = new Intl.DateTimeFormat("en-US", { month: "long" }).format(start);
      return `${month} ${start.getDate()}-${end.getDate()}, ${start.getFullYear()}`;
    }

    if (sameYear) {
      const startLabel = new Intl.DateTimeFormat("en-US", {
        month: "long",
        day: "numeric",
      }).format(start);
      const endLabel = new Intl.DateTimeFormat("en-US", {
        month: "long",
        day: "numeric",
      }).format(end);
      return `${startLabel} - ${endLabel}, ${start.getFullYear()}`;
    }

    const startLabel = new Intl.DateTimeFormat("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(start);
    const endLabel = new Intl.DateTimeFormat("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(end);
    return `${startLabel} - ${endLabel}`;
  }

  function toggleSort(
    key: "client" | "contact" | "stage" | "eventType" | "when" | "venue" | "workspaceSummary" | "contractTotal" | "lastModified"
  ) {
    if (sortKey === key) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDirection(key === "lastModified" ? "desc" : "asc");
  }

  const sortedWorkspaces = useMemo(() => {
    const rows = [...workspaces];
    rows.sort((a, b) => {
      let aVal: string | number = "";
      let bVal: string | number = "";

      if (sortKey === "client") {
        aVal = a.clientName || "";
        bVal = b.clientName || "";
      } else if (sortKey === "contact") {
        aVal = contactForRow(a);
        bVal = contactForRow(b);
      } else if (sortKey === "stage") {
        aVal = stageChip(a).label;
        bVal = stageChip(b).label;
      } else if (sortKey === "eventType") {
        aVal = a.eventType || "";
        bVal = b.eventType || "";
      } else if (sortKey === "when") {
        aVal = whenTimestampForSort(a);
        bVal = whenTimestampForSort(b);
      } else if (sortKey === "venue") {
        aVal = a.venue || "";
        bVal = b.venue || "";
      } else if (sortKey === "workspaceSummary") {
        aVal = `${a.workspaceTitle || ""} ${a.latestContextSummary || ""}`;
        bVal = `${b.workspaceTitle || ""} ${b.latestContextSummary || ""}`;
      } else if (sortKey === "contractTotal") {
        aVal = a.contractTotalAmount || 0;
        bVal = b.contractTotalAmount || 0;
      } else {
        aVal = new Date(a.lastModifiedAt).getTime();
        bVal = new Date(b.lastModifiedAt).getTime();
      }

      if (typeof aVal === "number" || typeof bVal === "number") {
        const aNum = Number(aVal || 0);
        const bNum = Number(bVal || 0);
        return sortDirection === "asc" ? aNum - bNum : bNum - aNum;
      }

      const left = String(aVal || "").toLowerCase();
      const right = String(bVal || "").toLowerCase();
      const compared = left.localeCompare(right);
      return sortDirection === "asc" ? compared : -compared;
    });
    return rows;
  }, [sortDirection, sortKey, workspaces]);

  function headerCell(args: {
    key: "client" | "contact" | "stage" | "eventType" | "when" | "venue" | "workspaceSummary" | "contractTotal" | "lastModified";
    label: string;
  }) {
    const active = sortKey === args.key;
    const arrow = !active ? "↕" : sortDirection === "asc" ? "↑" : "↓";
    return (
      <th className="px-3 py-2 whitespace-nowrap">
        <button
          type="button"
          onClick={() => toggleSort(args.key)}
          className={`inline-flex items-center gap-1 ${active ? "text-blue-200" : "text-slate-300 hover:text-white"}`}
        >
          <span>{args.label}</span>
          <span className="text-[10px]">{arrow}</span>
        </button>
      </th>
    );
  }

  return (
    <div className="space-y-3">
      <div className="max-w-full overflow-x-auto overflow-y-hidden rounded-xl border border-white/15 bg-white/5 shadow-sm backdrop-blur">
        <table className="min-w-full text-left text-xs">
          <thead className="bg-black/20 text-slate-300">
            <tr>
              {headerCell({ key: "client", label: "Client" })}
              {headerCell({ key: "contact", label: "Contact" })}
              {headerCell({ key: "stage", label: "Stage" })}
              {headerCell({ key: "eventType", label: "Event Type" })}
              {headerCell({ key: "when", label: "When" })}
              {headerCell({ key: "venue", label: "Venue" })}
              {headerCell({ key: "workspaceSummary", label: "Workspace Summary" })}
              {headerCell({ key: "contractTotal", label: "Contract Total" })}
              {headerCell({ key: "lastModified", label: "Last Modified" })}
              <th className="px-3 py-2 whitespace-nowrap">Action</th>
            </tr>
          </thead>
          <tbody>
            {sortedWorkspaces.map((workspace) => {
              const stageInfo = stageChip(workspace);
              return (
                <tr
                  key={workspace.eventId}
                  className="border-t border-white/10 text-slate-100 cursor-pointer hover:bg-white/5"
                  onClick={() => router.push(`/admin/workspace/${workspace.eventId}`)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      router.push(`/admin/workspace/${workspace.eventId}`);
                    }
                  }}
                  tabIndex={0}
                >
                <td className="px-3 py-2 whitespace-nowrap">
                  <span className="font-medium">{workspace.clientName}</span>
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{contactForRow(workspace)}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 font-medium ${stageInfo.className}`}
                  >
                    {stageInfo.label}
                  </span>
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{workspace.eventType || "Event"}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {formatDateOnlyRange(
                    workspace.workspaceStartTimestamp,
                    workspace.workspaceEndTimestamp,
                    formatDateShort({
                      timestamp: parseDateToTimestamp(workspace.eventDate) || workspace.eventDateTimestamp,
                      isoDate: workspace.eventDate,
                      fallback: "Unknown date",
                    })
                  )}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{workspace.venue || "-"}</td>
                <td className="max-w-xs px-3 py-2">
                  <div className="space-y-1">
                    <p className="truncate text-slate-100">{workspace.workspaceTitle || `${workspace.clientName}'s ${workspace.eventType || "Event"}`}</p>
                    <p className="truncate text-[11px] text-slate-400">{workspace.latestContextSummary || "No recent context."}</p>
                  </div>
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {new Intl.NumberFormat("en-US", {
                    style: "currency",
                    currency: "USD",
                    maximumFractionDigits: 0,
                  }).format(workspace.contractTotalAmount || 0)}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{new Date(workspace.lastModifiedAt).toLocaleString()}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <div className="flex items-center">
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        handleDelete(workspace.eventId);
                      }}
                      disabled={Boolean(deletingEventId)}
                      className="rounded border border-rose-400/40 px-3 py-1.5 text-xs text-rose-100 hover:bg-rose-500/20 disabled:opacity-50"
                    >
                      {deletingEventId === workspace.eventId ? "Deleting..." : "Delete"}
                    </button>
                  </div>
                </td>
              </tr>
              );
            })}

            {!workspaces.length ? (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-center text-xs text-slate-300">
                  No workspaces yet. Process context to create one.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {status ? <p className="text-sm text-slate-200">{status}</p> : null}
    </div>
  );
}
