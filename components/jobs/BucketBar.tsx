"use client";

import { useRouter, usePathname } from "next/navigation";
import { useState } from "react";
import {
  serializeJobView,
  withView,
  type JobView,
} from "@/lib/domain/jobs/filters";
import { JOB_BUCKETS, type JobBucket } from "@/lib/domain/jobs/buckets";

// ---------------------------------------------------------------------------
// What replaced the filter bar.
//
// The old bar had nine controls, every one of which was really a preference
// ("remote only", "score 40+") that the reader had to re-declare on each visit
// and that hid anything just outside the cut. Those preferences moved into the
// profile, where they shape the ORDER instead. What is left is navigation:
// which pile, and find-that-one-company.
//
// Holds NO state of its own beyond the search draft: it renders what it is
// given and pushes a new query string, so the URL stays the single source of
// truth and a view is bookmarkable.
// ---------------------------------------------------------------------------

const LABELS: Record<JobBucket, string> = {
  inbox: "Inbox",
  working: "Working",
  archive: "Archive",
};

const BLURB: Record<JobBucket, string> = {
  inbox: "New to you, ranked against your profile.",
  working: "Jobs you've picked up.",
  archive: "Dismissed, or timed out before you got to them.",
};

export default function BucketBar({
  view,
  counts,
  shown,
  total,
  staleDays,
  newCount,
}: {
  view: JobView;
  counts: Record<JobBucket, number>;
  shown: number;
  total: number;
  staleDays: number;
  newCount: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [draftQuery, setDraftQuery] = useState(view.query ?? "");

  function apply(next: JobView) {
    const qs = serializeJobView(next).toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <div className="space-y-2 border-b border-(--border) px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {JOB_BUCKETS.map((bucket) => {
          const active = view.bucket === bucket;
          return (
            <button
              key={bucket}
              type="button"
              onClick={() => apply(withView(view, { bucket }))}
              className={`rounded border px-2 py-0.5 text-[11px] transition ${
                active
                  ? "border-(--border-strong) bg-(--surface-hover) text-(--text)"
                  : "border-(--border-strong) text-(--text-muted) hover:text-(--text)"
              }`}
            >
              {LABELS[bucket]}{" "}
              <span className="tnum text-(--text-faint)">{counts[bucket]}</span>
            </button>
          );
        })}

        <span className="mx-1 text-(--border-strong)">|</span>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            apply(withView(view, { query: draftQuery.trim() || undefined }));
          }}
        >
          <input
            value={draftQuery}
            onChange={(e) => setDraftQuery(e.target.value)}
            placeholder="find a title or company…"
            className="w-52 rounded border border-(--border-strong) bg-transparent px-2 py-0.5 text-[11px] text-(--text) placeholder:text-(--text-faint)"
          />
        </form>

        {view.query && (
          <button
            type="button"
            onClick={() => {
              setDraftQuery("");
              apply(withView(view, { query: undefined }));
            }}
            className="rounded border border-(--border-strong) px-2 py-0.5 text-[11px] text-(--text-muted) hover:text-(--text)"
          >
            clear
          </button>
        )}
      </div>

      <div className="tnum flex flex-wrap items-center gap-2 text-[11px] text-(--text-faint)">
        <span>
          {shown === total ? `${total} jobs` : `${shown} shown · ${total} in this pile`}
        </span>
        {newCount > 0 && (
          <span className="text-(--info-fg)">{newCount} new since you last looked</span>
        )}
        <span>· {BLURB[view.bucket]}</span>
        {view.bucket === "inbox" && (
          <span>Untriaged jobs move to Archive after {staleDays} days.</span>
        )}
      </div>
    </div>
  );
}
