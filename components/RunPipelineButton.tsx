"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Counters = {
  newJobs: number;
  newLeads: number;
  duplicatesMerged: number;
  jobsEnriched: number;
  applicationsAutoSent: number;
  applicationsQueued: number;
  outreachAutoSent: number;
  outreachQueued: number;
  repliesDetected: number;
  followUpsSent: number;
};

type RunResult = {
  dryRun: boolean;
  counters: Counters;
  /** Things that broke. */
  errors: string[];
  /** Things working as configured that are still worth knowing. */
  notices: string[];
  budgetExhausted: boolean;
  elapsedMs: number;
};

type State =
  | { status: "idle" }
  | { status: "running"; startedAt: number }
  | { status: "done"; result: RunResult }
  | { status: "error"; message: string };

const LABELS: Array<[keyof Counters, string]> = [
  ["newJobs", "new jobs"],
  ["newLeads", "new leads"],
  ["duplicatesMerged", "duplicates merged"],
  ["jobsEnriched", "descriptions recovered"],
  ["applicationsAutoSent", "applications sent"],
  ["applicationsQueued", "queued for one keystroke"],
  ["outreachAutoSent", "pitches sent"],
  ["outreachQueued", "pitches queued"],
  ["repliesDetected", "replies detected"],
  ["followUpsSent", "follow-ups sent"],
];

export default function RunPipelineButton({ dryRun }: { dryRun: boolean }) {
  const [state, setState] = useState<State>({ status: "idle" });
  const router = useRouter();

  async function run() {
    setState({ status: "running", startedAt: Date.now() });
    try {
      const res = await fetch("/api/actions/run-pipeline", { method: "POST" });

      // The session can expire while the tab is open; proxy.ts answers 401 with
      // JSON rather than an HTML redirect, so say something useful instead of
      // failing on a parse error.
      if (res.status === 401) {
        setState({
          status: "error",
          message: "Your session expired. Reload the page and sign in again.",
        });
        return;
      }

      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        setState({
          status: "error",
          message:
            body?.error ??
            body?.issues?.join("; ") ??
            `Request failed with HTTP ${res.status}.`,
        });
        return;
      }

      setState({ status: "done", result: body.result as RunResult });
      // Pull fresh server data so the counters and the apply queue reflect the
      // run without a manual reload.
      router.refresh();
    } catch (err) {
      setState({
        status: "error",
        message:
          err instanceof Error
            ? `${err.message}. If the run took longer than the function limit, it may still have completed — check the run log on the Overview page.`
            : String(err),
      });
    }
  }

  const running = state.status === "running";
  const open = state.status === "done" || state.status === "error";

  return (
    <div className="flex items-center gap-2">
      <span className="hidden text-[10px] text-(--text-dim) sm:inline">
        {dryRun ? "dry run — no email" : "live — sends email"}
      </span>
      <button
        onClick={run}
        disabled={running}
        title={
          dryRun
            ? "DRY_RUN is on — this drafts everything and sends no email."
            : "Live — this sends real applications, pitches and follow-ups."
        }
        className={`rounded px-3 py-1 text-xs font-medium transition ${
          running
            ? "cursor-not-allowed bg-(--surface) text-(--text-faint)"
            : dryRun
              ? "bg-(--warn-bg) text-(--warn-fg) hover:brightness-125"
              : "bg-(--ok-bg) text-(--ok-fg) hover:brightness-125"
        }`}
      >
        {running ? "Running…" : dryRun ? "Run (dry)" : "Run pipeline"}
      </button>

      {open && (
        <div className="absolute right-6 top-full z-20 mt-2 w-104 rounded border border-(--border) bg-(--surface) p-3 shadow-lg">
          <button
            onClick={() => setState({ status: "idle" })}
            className="float-right text-xs text-(--text-faint) hover:text-(--text)"
            aria-label="Dismiss run result"
          >
            ✕
          </button>
          {state.status === "error" ? (
            <div className="text-sm text-(--danger-fg)">
              <div className="font-semibold">Run failed</div>
              <div className="mt-1 font-mono text-xs wrap-break-word">
                {state.message}
              </div>
            </div>
          ) : (
            <RunSummary result={state.result} />
          )}
        </div>
      )}
    </div>
  );
}

function RunSummary({ result }: { result: RunResult }) {
  const { counters, errors, notices, budgetExhausted, dryRun, elapsedMs } =
    result;
  const moved = LABELS.filter(([key]) => counters[key] > 0);

  return (
    <div className="space-y-2 rounded border border-(--border) p-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-semibold text-(--ok-fg)">Run complete</span>
        <span className="text-xs text-(--text-muted)">
          {(elapsedMs / 1000).toFixed(1)}s{dryRun ? " · dry run, no email sent" : ""}
        </span>
      </div>

      {moved.length === 0 ? (
        <p className="text-xs text-(--text-muted)">
          Nothing changed — no new listings, and nothing was queued. That is a
          normal result when the sources have not published anything since the
          last run.
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-(--text-muted) sm:grid-cols-3">
          {moved.map(([key, label]) => (
            <li key={key}>
              <span className="font-semibold text-(--text)">{counters[key]}</span>{" "}
              {label}
            </li>
          ))}
        </ul>
      )}

      {budgetExhausted && (
        <p className="text-xs text-(--warn-fg)">
          Stopped at the time budget with work still queued. Nothing was lost —
          run again to continue draining it.
        </p>
      )}

      {/* Problems are shown expanded and in red; notices stay collapsed. Giving
          both the same weight is what made a run with two dead sources look
          identical to one with three switched-off ones. */}
      {errors.length > 0 && (
        <div className="rounded border border-(--border) p-2 text-xs">
          <div className="font-semibold text-(--danger-fg)">
            {errors.length} problem{errors.length === 1 ? "" : "s"} — these need
            fixing
          </div>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-(--danger-fg)">
            {errors.slice(0, 25).map((e, i) => (
              <li key={i} className="wrap-break-word">
                {e}
              </li>
            ))}
            {errors.length > 25 && (
              <li>…and {errors.length - 25} more (see the Overview run log)</li>
            )}
          </ul>
        </div>
      )}

      {notices.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-(--text-muted)">
            {notices.length} thing{notices.length === 1 ? "" : "s"} worth knowing
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-(--text-muted)">
            {notices.map((n, i) => (
              <li key={i} className="wrap-break-word">
                {n}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
