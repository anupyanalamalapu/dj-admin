import { BookingStage } from "@/lib/admin/types/models";

const STAGE_CLASS: Record<BookingStage, string> = {
  inquiry: "bg-amber-100 text-amber-800 border-amber-200",
  in_contract: "bg-blue-100 text-blue-800 border-blue-200",
  execution: "bg-emerald-100 text-emerald-800 border-emerald-200",
  cancelled: "bg-rose-100 text-rose-800 border-rose-200",
  completed: "bg-slate-100 text-slate-800 border-slate-200",
};

const STAGE_LABEL: Record<BookingStage, string> = {
  inquiry: "Inquiry",
  in_contract: "In Contract",
  execution: "Executing",
  cancelled: "Cancelled",
  completed: "Complete",
};

export default function StageBadge({ stage }: { stage: BookingStage }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-1 text-xs font-medium ${STAGE_CLASS[stage]}`}>
      {STAGE_LABEL[stage]}
    </span>
  );
}
