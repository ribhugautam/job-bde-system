"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/infra/http/postJson";

/**
 * Dismiss sets status to `ignored` through the EXISTING update-status endpoint.
 * No new route, no schema change — `ignored` has always been a valid job status.
 * Nothing is destroyed: the "show dismissed" filter brings these back, and the
 * same button un-dismisses.
 */
export default function DismissButton({
  jobId,
  dismissed,
}: {
  jobId: number;
  dismissed: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setBusy(true);
    setError(null);
    // postJson never throws, so `setBusy(false)` is reached on every path.
    // Parsing the body before checking res.ok used to strand this button
    // disabled whenever the route answered with a non-JSON 500.
    const res = await postJson("/api/actions/update-status", {
      entity: "job",
      id: jobId,
      status: dismissed ? "found" : "ignored",
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    router.refresh();
  }

  return (
    <span className="flex flex-col items-end gap-0.5">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        title={dismissed ? "Restore this job" : "Dismiss this job"}
        className="shrink-0 text-[11px] text-(--text-faint) hover:text-(--text-muted) disabled:opacity-50"
      >
        {dismissed ? "restore" : "dismiss"}
      </button>
      {error && (
        <span className="max-w-40 text-right text-[10px] text-(--danger-fg)">{error}</span>
      )}
    </span>
  );
}
