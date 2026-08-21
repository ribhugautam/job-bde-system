"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/infra/http/postJson";
import { JOB_STATUSES } from "@/lib/pipeline/state";

// ---------------------------------------------------------------------------
// Per-user triage controls.
//
// Everything here writes to /api/actions/job-state, which is scoped to the
// signed-in user -- NOT to /api/actions/update-status, which writes the shared
// `jobs.status` the pipeline owns. Using the latter would mean one colleague
// dismissing a job hid it from everybody.
//
// postJson never throws, so the busy flag is always cleared. These controls
// previously parsed the response before checking res.ok, which stranded them
// disabled whenever a route answered with a non-JSON 500.
// ---------------------------------------------------------------------------

function useJobState(jobId: number) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(status: string | null) {
    setBusy(true);
    setError(null);
    const res = await postJson("/api/actions/job-state", { jobId, status });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    router.refresh();
  }

  return { busy, error, send };
}

/**
 * Dismiss moves a job to Archive for this user only. Restore CLEARS the row
 * rather than setting `found`, returning the job to genuinely untriaged -- see
 * clearJobStatusForUser for why those two are not the same thing.
 */
export function DismissButton({
  jobId,
  dismissed,
}: {
  jobId: number;
  dismissed: boolean;
}) {
  const { busy, error, send } = useJobState(jobId);

  return (
    <span className="flex flex-col items-end gap-0.5">
      <button
        type="button"
        onClick={() => send(dismissed ? null : "ignored")}
        disabled={busy}
        title={dismissed ? "Put this back in your inbox" : "Dismiss this job"}
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

/** One click to move an untriaged job into Working. */
export function KeepButton({ jobId }: { jobId: number }) {
  const { busy, error, send } = useJobState(jobId);

  return (
    <span className="flex flex-col items-end gap-0.5">
      <button
        type="button"
        onClick={() => send("matched")}
        disabled={busy}
        title="Move this to Working"
        className="shrink-0 rounded border border-(--border-strong) px-1.5 text-[11px] text-(--text-muted) hover:text-(--text) disabled:opacity-50"
      >
        keep
      </button>
      {error && (
        <span className="max-w-40 text-right text-[10px] text-(--danger-fg)">{error}</span>
      )}
    </span>
  );
}

/**
 * The full status list. Several statuses -- responded, interview, offer -- are
 * reachable from nowhere else in the UI, so this stays a complete list rather
 * than the two or three the buttons above cover. The options come from
 * lib/pipeline/state.ts; a local copy here is what drifted last time.
 */
export function JobStatusSelect({
  jobId,
  status,
}: {
  jobId: number;
  status: string | null;
}) {
  const { busy, error, send } = useJobState(jobId);

  return (
    <span className="flex flex-col items-end gap-0.5">
      <select
        value={status ?? ""}
        disabled={busy}
        onChange={(e) => send(e.target.value === "" ? null : e.target.value)}
        className="rounded border border-(--border-strong) bg-(--surface) px-1 py-0.5 text-[11px] text-(--text-muted) disabled:opacity-50"
      >
        {/* The empty option is how a job is returned to untriaged. */}
        <option value="">untriaged</option>
        {JOB_STATUSES.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      {error && (
        <span className="max-w-40 text-right text-[10px] text-(--danger-fg)">{error}</span>
      )}
    </span>
  );
}
