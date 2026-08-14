const COLORS: Record<string, string> = {
  // reached a good end state
  sent: "bg-(--ok-bg) text-(--ok-fg)",
  offer: "bg-(--ok-bg) text-(--ok-fg)",
  won: "bg-(--ok-bg) text-(--ok-fg)",
  applied: "bg-(--ok-bg) text-(--ok-fg)",
  // waiting on the operator
  ready_for_review: "bg-(--warn-bg) text-(--warn-fg)",
  pitched: "bg-(--warn-bg) text-(--warn-fg)",
  // someone replied — in play
  responded: "bg-(--info-bg) text-(--info-fg)",
  interview: "bg-(--info-bg) text-(--info-fg)",
  matched: "bg-(--info-bg) text-(--info-fg)",
  drafted: "bg-(--info-bg) text-(--info-fg)",
  // over, unsuccessfully
  rejected: "bg-(--danger-bg) text-(--danger-fg)",
  lost: "bg-(--danger-bg) text-(--danger-fg)",
  failed: "bg-(--danger-bg) text-(--danger-fg)",
  // no verdict
  found: "bg-(--neutral-bg) text-(--neutral-fg)",
  ignored: "bg-(--neutral-bg) text-(--text-faint)",
  closed: "bg-(--neutral-bg) text-(--text-faint)",
};

export default function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${
        COLORS[status] || "bg-(--neutral-bg) text-(--neutral-fg)"
      }`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}
