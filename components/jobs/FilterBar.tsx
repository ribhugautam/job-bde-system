"use client";

import { useRouter, usePathname } from "next/navigation";
import { useState } from "react";
import {
  serializeJobFilters,
  toggleInList,
  type JobFilters,
} from "@/lib/domain/jobs/filters";
import type { GeoEligibility, WorkArrangement } from "@/lib/domain/facts";

// ---------------------------------------------------------------------------
// The filter bar holds NO filter logic. It renders the state it is given and
// pushes a new query string; the server re-renders the list. That keeps the URL
// the single source of filter truth, so a filtered view is bookmarkable and the
// back button works.
// ---------------------------------------------------------------------------

const ELIGIBILITY: { value: GeoEligibility; label: string }[] = [
  { value: "eligible", label: "India-eligible" },
  { value: "worldwide", label: "worldwide" },
  { value: "unknown", label: "unstated" },
  { value: "restricted", label: "restricted" },
];

const ARRANGEMENT: { value: WorkArrangement; label: string }[] = [
  { value: "remote", label: "remote" },
  { value: "hybrid", label: "hybrid" },
  { value: "onsite", label: "on-site" },
];

function Toggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border px-2 py-0.5 text-[11px] transition ${
        active
          ? "border-(--border-strong) bg-(--surface-hover) text-(--text)"
          : "border-(--border-strong) text-(--text-muted) hover:text-(--text)"
      }`}
    >
      {children}
    </button>
  );
}

export default function FilterBar({
  filters,
  total,
  shown,
  sources,
}: {
  filters: JobFilters;
  total: number;
  shown: number;
  sources: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [draftQuery, setDraftQuery] = useState(filters.query ?? "");

  function apply(next: JobFilters) {
    const qs = serializeJobFilters(next).toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <div className="space-y-2 border-b border-(--border) px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            apply({ ...filters, query: draftQuery.trim() || undefined });
          }}
          className="mr-1"
        >
          <input
            value={draftQuery}
            onChange={(e) => setDraftQuery(e.target.value)}
            placeholder="search title or company…"
            className="w-48 rounded border border-(--border-strong) bg-transparent px-2 py-0.5 text-[11px] text-(--text) placeholder:text-(--text-faint)"
          />
        </form>

        {ELIGIBILITY.map((option) => (
          <Toggle
            key={option.value}
            active={filters.eligibility.includes(option.value)}
            onClick={() =>
              apply({ ...filters, eligibility: toggleInList(filters.eligibility, option.value) })
            }
          >
            {option.label}
          </Toggle>
        ))}

        <span className="mx-1 text-(--border-strong)">|</span>

        {ARRANGEMENT.map((option) => (
          <Toggle
            key={option.value}
            active={filters.arrangement.includes(option.value)}
            onClick={() =>
              apply({ ...filters, arrangement: toggleInList(filters.arrangement, option.value) })
            }
          >
            {option.label}
          </Toggle>
        ))}

        <span className="mx-1 text-(--border-strong)">|</span>

        <Toggle
          active={filters.easyApplyOnly}
          onClick={() => apply({ ...filters, easyApplyOnly: !filters.easyApplyOnly })}
        >
          easy apply
        </Toggle>
        <Toggle
          active={filters.minScore !== undefined}
          onClick={() =>
            apply({ ...filters, minScore: filters.minScore === undefined ? 40 : undefined })
          }
        >
          score 40+
        </Toggle>
        <Toggle
          active={filters.showDismissed}
          onClick={() => apply({ ...filters, showDismissed: !filters.showDismissed })}
        >
          show dismissed
        </Toggle>
        <Toggle
          active={filters.sort === "newest"}
          onClick={() => apply({ ...filters, sort: filters.sort === "newest" ? "score" : "newest" })}
        >
          newest first
        </Toggle>

        {sources.length > 0 && (
          <select
            value={filters.sources[0] ?? ""}
            onChange={(e) =>
              apply({ ...filters, sources: e.target.value ? [e.target.value] : [] })
            }
            className="rounded border border-(--border-strong) bg-transparent px-1.5 py-0.5 text-[11px] text-(--text-muted)"
          >
            <option value="">all sources</option>
            {sources.map((source) => (
              <option key={source} value={source}>
                {source}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="tnum text-[11px] text-(--text-faint)">
        {shown === total ? `${total} jobs` : `${shown} shown · ${total} match`}
      </div>
    </div>
  );
}
