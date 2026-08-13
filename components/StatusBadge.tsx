const COLORS: Record<string, string> = {
  found: "bg-neutral-700 text-neutral-200",
  matched: "bg-blue-900 text-blue-200",
  drafted: "bg-blue-900 text-blue-200",
  ready_for_review: "bg-amber-900 text-amber-200",
  pitched: "bg-amber-900 text-amber-200",
  sent: "bg-emerald-900 text-emerald-200",
  responded: "bg-purple-900 text-purple-200",
  interview: "bg-purple-900 text-purple-200",
  offer: "bg-green-800 text-green-100",
  won: "bg-green-800 text-green-100",
  rejected: "bg-red-900 text-red-200",
  lost: "bg-red-900 text-red-200",
  failed: "bg-red-900 text-red-200",
  ignored: "bg-neutral-800 text-neutral-500",
};

export default function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${
        COLORS[status] || "bg-neutral-800 text-neutral-300"
      }`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}
