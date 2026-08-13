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
  errors: string[];
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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={run}
          disabled={running}
          className={`rounded px-3 py-1.5 text-sm font-medium transition ${
            running
              ? "cursor-not-allowed bg-neutral-800 text-neutral-500"
              : dryRun
                ? "bg-amber-700 text-white hover:bg-amber-600"
                : "bg-emerald-700 text-white hover:bg-emerald-600"
          }`}
        >
          {running
            ? "Running…"
            : dryRun
              ? "Run pipeline (dry run)"
              : "Run pipeline now"}
        </button>

        {running && (
          <span className="text-xs text-neutral-400">
            This can take 30–50 seconds. Leave the tab open.
          </span>
        )}

        {!running && (
          <span className="text-xs text-neutral-500">
            {dryRun
              ? "DRY_RUN is on — this drafts everything and sends no email."
              : "Live — this sends real applications, pitches and follow-ups."}
          </span>
        )}
      </div>

      {state.status === "error" && (
        <div className="rounded border border-red-900 bg-red-950/40 p-3 text-sm text-red-200">
          <div className="font-semibold">Run failed</div>
          <div className="mt-1 font-mono text-xs break-words">{state.message}</div>
        </div>
      )}

      {state.status === "done" && <RunSummary result={state.result} />}
    </div>
  );
}

function RunSummary({ result }: { result: RunResult }) {
  const { counters, errors, budgetExhausted, dryRun, elapsedMs } = result;
  const moved = LABELS.filter(([key]) => counters[key] > 0);

  return (
    <div className="space-y-2 rounded border border-neutral-800 bg-neutral-900/40 p-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-semibold text-emerald-400">Run complete</span>
        <span className="text-xs text-neutral-500">
          {(elapsedMs / 1000).toFixed(1)}s{dryRun ? " · dry run, no email sent" : ""}
        </span>
      </div>

      {moved.length === 0 ? (
        <p className="text-xs text-neutral-400">
          Nothing changed — no new listings, and nothing was queued. That is a
          normal result when the sources have not published anything since the
          last run.
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-neutral-300 sm:grid-cols-3">
          {moved.map(([key, label]) => (
            <li key={key}>
              <span className="font-semibold text-white">{counters[key]}</span>{" "}
              {label}
            </li>
          ))}
        </ul>
      )}

      {budgetExhausted && (
        <p className="text-xs text-amber-400">
          Stopped at the time budget with work still queued. Nothing was lost —
          run again to continue draining it.
        </p>
      )}

      {errors.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-amber-400">
            {errors.length} notice{errors.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-neutral-400">
            {errors.slice(0, 25).map((e, i) => (
              <li key={i} className="break-words">
                {e}
              </li>
            ))}
            {errors.length > 25 && (
              <li>…and {errors.length - 25} more (see the Overview run log)</li>
            )}
          </ul>
        </details>
      )}
    </div>
  );
}
