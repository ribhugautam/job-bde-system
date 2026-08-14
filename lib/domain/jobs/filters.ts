import type { GeoEligibility, WorkArrangement } from "@/lib/domain/facts";

// ---------------------------------------------------------------------------
// The job list's filter state, as it travels in the URL.
//
// Pure: no database, no React, no Next.js. The URL is the single source of
// filter truth, which makes a filtered view bookmarkable and means the page
// needs no client state at all.
//
// PARSING IS TOTAL. Every value here arrives from a query string a human can
// edit by hand. An unrecognised eligibility, a non-numeric score or a bogus
// sort key is DROPPED rather than thrown on — a malformed URL must render an
// unfiltered page, never a stack trace, and must never reach SQL.
// ---------------------------------------------------------------------------

export const JOB_SORTS = ["score", "newest"] as const;
export type JobSort = (typeof JOB_SORTS)[number];

const ELIGIBILITIES = ["worldwide", "eligible", "restricted", "unknown"] as const;
const ARRANGEMENTS = ["remote", "hybrid", "onsite", "unknown"] as const;

export type JobFilters = {
  /** Empty means no constraint, NOT "none of them". */
  eligibility: GeoEligibility[];
  arrangement: WorkArrangement[];
  sources: string[];
  minScore?: number;
  easyApplyOnly: boolean;
  /** Matched against title and company. */
  query?: string;
  /** false hides rows whose status is `ignored`. */
  showDismissed: boolean;
  sort: JobSort;
};

export const DEFAULT_JOB_FILTERS: JobFilters = {
  eligibility: [],
  arrangement: [],
  sources: [],
  minScore: undefined,
  easyApplyOnly: false,
  query: undefined,
  showDismissed: false,
  sort: "score",
};

/** Accepts both `?k=a&k=b` and `?k=a,b`, so hand-edited URLs behave. */
function readList(params: URLSearchParams, key: string): string[] {
  return params
    .getAll(key)
    .flatMap((raw) => raw.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
}

function readBool(params: URLSearchParams, key: string): boolean {
  const raw = params.get(key);
  return raw === "1" || raw === "true";
}

export function parseJobFilters(params: URLSearchParams): JobFilters {
  const eligibility = readList(params, "eligibility").filter((v): v is GeoEligibility =>
    (ELIGIBILITIES as readonly string[]).includes(v)
  );
  const arrangement = readList(params, "arrangement").filter((v): v is WorkArrangement =>
    (ARRANGEMENTS as readonly string[]).includes(v)
  );

  const rawScore = params.get("minScore");
  const parsedScore = rawScore === null ? NaN : Number(rawScore);
  const minScore = Number.isFinite(parsedScore)
    ? Math.max(0, Math.min(100, Math.round(parsedScore)))
    : undefined;

  const rawSort = params.get("sort");
  const sort = (JOB_SORTS as readonly string[]).includes(rawSort ?? "")
    ? (rawSort as JobSort)
    : DEFAULT_JOB_FILTERS.sort;

  const query = params.get("q")?.trim() || undefined;

  return {
    eligibility,
    arrangement,
    sources: readList(params, "source"),
    minScore,
    easyApplyOnly: readBool(params, "easyApply"),
    query,
    showDismissed: readBool(params, "dismissed"),
    sort,
  };
}

/** Omits defaults, so an unfiltered view has an empty query string. */
export function serializeJobFilters(filters: JobFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.eligibility.length) params.set("eligibility", filters.eligibility.join(","));
  if (filters.arrangement.length) params.set("arrangement", filters.arrangement.join(","));
  if (filters.sources.length) params.set("source", filters.sources.join(","));
  if (filters.minScore !== undefined) params.set("minScore", String(filters.minScore));
  if (filters.easyApplyOnly) params.set("easyApply", "1");
  if (filters.query) params.set("q", filters.query);
  if (filters.showDismissed) params.set("dismissed", "1");
  if (filters.sort !== DEFAULT_JOB_FILTERS.sort) params.set("sort", filters.sort);
  return params;
}

/** Add if absent, remove if present. Never mutates its input. */
export function toggleInList<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}
