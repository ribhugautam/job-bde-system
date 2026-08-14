"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

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
    const res = await fetch("/api/actions/update-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entity: "job",
        id: jobId,
        status: dismissed ? "found" : "ignored",
      }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error || "failed");
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
