"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Chip, { type ChipTone } from "@/components/ui/Chip";
import { jobFactChips } from "@/components/jobs/factChips";

export type QueueItem = {
  jobId: number;
  title: string;
  company: string;
  location: string | null;
  source: string;
  url: string;
  score: number;
  salaryText: string | null;
  coverLetter: string;
  scoreReasons: string[];
  // Phase 3: the facts Phases 1 and 2 derived, so the queue and the Jobs
  // archive describe the same job the same way.
  arrangement: string | null;
  geoEligibility: string | null;
  minYears: number | null;
  easyApply: boolean | null;
};

type Props = { items: QueueItem[] };

// Toast tone reuses the chip vocabulary for operational feedback (copied,
// undone, failed) rather than the fixed green the queue used to show for
// every message, success or failure alike.
const TOAST_TONE: Record<ChipTone, string> = {
  ok: "border-transparent bg-(--ok-bg) text-(--ok-fg)",
  info: "border-transparent bg-(--info-bg) text-(--info-fg)",
  warn: "border-transparent bg-(--warn-bg) text-(--warn-fg)",
  danger: "border-transparent bg-(--danger-bg) text-(--danger-fg)",
  neutral: "border-(--border) bg-(--surface) text-(--text-muted)",
};

/**
 * The one-keystroke apply queue.
 *
 * `Enter` does three things at once — copy the letter, open the posting, mark
 * it applied — because that combination is the entire point: everything
 * expensive (finding, scoring, writing) already happened unattended, and this
 * is the single human action left.
 *
 * Clipboard write happens BEFORE window.open. Browsers only honor a clipboard
 * write inside a real user-gesture task, and opening a tab first can steal
 * focus and invalidate the gesture, which produces the worst possible failure:
 * the tab opens and the letter silently is not on the clipboard, so you paste
 * whatever was there before.
 */
export default function ApplyQueue({ items }: Props) {
  const queue = items;
  // Stored unclamped and clamped at read time. If a new pipeline run shortens
  // the list, a stored index could point past the end; clamping on read means
  // that self-corrects without an effect that writes state during render.
  const [rawCursor, setCursor] = useState(0);
  const cursor = Math.min(rawCursor, Math.max(0, queue.length - 1));
  const [applied, setApplied] = useState<Set<number>>(new Set());
  const [toast, setToast] = useState<{ msg: string; tone: ChipTone } | null>(
    null
  );
  // Remembers the order things were applied in, so `u` undoes the most recent
  // action rather than whatever the cursor happens to be sitting on.
  const history = useRef<number[]>([]);
  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const flash = useCallback((msg: string, tone: ChipTone = "neutral") => {
    setToast({ msg, tone });
    window.setTimeout(() => setToast(null), 2200);
  }, []);

  const post = useCallback(
    async (jobId: number, undo: boolean) => {
      try {
        const res = await fetch("/api/actions/mark-applied", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jobId, undo }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (err) {
        // Roll the optimistic update back. Showing "applied" for something the
        // server never recorded is the one failure that costs you a real job —
        // you would never come back to it.
        setApplied((prev) => {
          const next = new Set(prev);
          if (undo) next.add(jobId);
          else next.delete(jobId);
          return next;
        });
        flash(
          `Could not save — ${err instanceof Error ? err.message : "unknown error"}. Reverted.`,
          "danger"
        );
      }
    },
    [flash]
  );

  const applyCurrent = useCallback(async () => {
    const item = queue[cursor];
    if (!item) return;

    let copied = false;
    try {
      await navigator.clipboard.writeText(item.coverLetter);
      copied = true;
    } catch {
      copied = false;
    }

    window.open(item.url, "_blank", "noopener,noreferrer");

    setApplied((prev) => new Set(prev).add(item.jobId));
    history.current.push(item.jobId);
    void post(item.jobId, false);

    flash(
      copied
        ? "Letter copied — paste into the application."
        : "Opened, but the clipboard was blocked. Copy the letter manually below.",
      copied ? "ok" : "warn"
    );

    setCursor((c) => Math.min(c + 1, queue.length - 1));
  }, [queue, cursor, post, flash]);

  const undoLast = useCallback(() => {
    const jobId = history.current.pop();
    if (jobId === undefined) {
      flash("Nothing to undo.");
      return;
    }
    setApplied((prev) => {
      const next = new Set(prev);
      next.delete(jobId);
      return next;
    });
    void post(jobId, true);
    const idx = queue.findIndex((q) => q.jobId === jobId);
    if (idx >= 0) setCursor(idx);
    flash("Undone.", "ok");
  }, [queue, post, flash]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Never hijack typing in a field, and leave browser shortcuts alone.
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          setCursor((c) => Math.min(c + 1, queue.length - 1));
          break;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          setCursor((c) => Math.max(c - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          void applyCurrent();
          break;
        case "u":
          e.preventDefault();
          undoLast();
          break;
        case "s":
          // Skip without applying — keeps the queue honest when something is
          // obviously not worth the click.
          e.preventDefault();
          setCursor((c) => Math.min(c + 1, queue.length - 1));
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [queue.length, applyCurrent, undoLast]);

  useEffect(() => {
    const item = queue[cursor];
    if (!item) return;
    rowRefs.current
      .get(item.jobId)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [cursor, queue]);

  if (queue.length === 0) {
    return (
      <p className="text-sm text-(--text-dim)">
        Nothing queued. Jobs land here once the pipeline has scored and drafted
        them — anything with a published apply-by-email address is sent
        automatically and never reaches this queue.
      </p>
    );
  }

  const current = queue[cursor];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded border border-(--border) bg-(--surface) px-3 py-2 text-xs text-(--text-muted)">
        <span>
          <kbd className="rounded bg-(--surface-hover) px-1.5 py-0.5 text-(--text)">
            j
          </kbd>{" "}
          /{" "}
          <kbd className="rounded bg-(--surface-hover) px-1.5 py-0.5 text-(--text)">
            k
          </kbd>{" "}
          move
        </span>
        <span>
          <kbd className="rounded bg-(--surface-hover) px-1.5 py-0.5 text-(--text)">
            Enter
          </kbd>{" "}
          copy letter + open + mark applied
        </span>
        <span>
          <kbd className="rounded bg-(--surface-hover) px-1.5 py-0.5 text-(--text)">
            s
          </kbd>{" "}
          skip
        </span>
        <span>
          <kbd className="rounded bg-(--surface-hover) px-1.5 py-0.5 text-(--text)">
            u
          </kbd>{" "}
          undo
        </span>
        <span className="tnum ml-auto">
          {cursor + 1} / {queue.length} · {applied.size} applied
        </span>
      </div>

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={`rounded border px-3 py-2 text-sm ${TOAST_TONE[toast.tone]}`}
        >
          {toast.msg}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="max-h-[70vh] space-y-2 overflow-y-auto pr-1">
          {queue.map((item, i) => {
            const isCursor = i === cursor;
            const isApplied = applied.has(item.jobId);
            return (
              <div
                key={item.jobId}
                ref={(el) => {
                  if (el) rowRefs.current.set(item.jobId, el);
                  else rowRefs.current.delete(item.jobId);
                }}
                onClick={() => setCursor(i)}
                className={`cursor-pointer rounded border p-3 transition ${
                  isCursor
                    ? "border-(--border-strong) bg-(--surface-hover)"
                    : "border-(--border) hover:border-(--border-strong)"
                } ${isApplied ? "opacity-50" : ""}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-(--text)">
                      {item.title}
                    </div>
                    <div className="truncate text-xs text-(--text-muted)">
                      {item.company}
                      {item.location ? ` · ${item.location}` : ""} ·{" "}
                      {item.source}
                      {item.salaryText ? ` · ${item.salaryText}` : ""}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 text-xs">
                    {isApplied && (
                      <span className="text-(--ok-fg)">applied</span>
                    )}
                    {jobFactChips(item).map((chip) => (
                      <Chip key={chip.label} tone={chip.tone}>
                        {chip.label}
                      </Chip>
                    ))}
                    <span className="tnum text-(--text-dim)">
                      {item.score}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {current && (
          <div className="max-h-[70vh] overflow-y-auto rounded border border-(--border) p-3">
            <div className="mb-2 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <a
                  href={current.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-(--text) hover:underline"
                >
                  {current.title}
                </a>
                <div className="text-xs text-(--text-muted)">
                  {current.company} · score{" "}
                  <span className="tnum">{current.score}</span>
                </div>
              </div>
              <button
                onClick={() => void applyCurrent()}
                className="shrink-0 rounded bg-(--ok-bg) px-2 py-1 text-xs font-medium text-(--ok-fg) hover:brightness-125"
              >
                Copy &amp; open
              </button>
            </div>
            {current.scoreReasons.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1">
                {current.scoreReasons.map((r, i) => (
                  <span
                    key={i}
                    className="rounded bg-(--surface-hover) px-1.5 py-0.5 text-[10px] text-(--text-muted)"
                  >
                    {r}
                  </span>
                ))}
              </div>
            )}
            <pre className="whitespace-pre-wrap wrap-break-word rounded bg-(--surface-hover) p-3 text-xs leading-relaxed text-(--text)">
              {current.coverLetter}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
