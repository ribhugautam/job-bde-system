import { DEFAULT_BUCKET, parseBucket, type JobBucket } from "./buckets";

// ---------------------------------------------------------------------------
// The job list's view state, as it travels in the URL.
//
// This file used to hold a nine-axis filter model: geo eligibility,
// arrangement, source, minimum score, easy-apply, sort order, show-dismissed
// and a text query. All of it is gone, deliberately.
//
// The reason is not that filtering is bad — it is that a filter bar makes the
// READER do the ranking. Every axis of the old bar was really a preference
// ("I want remote", "I want 40+"), re-declared by hand on every visit, applied
// as a hard cut that hid anything just outside it. Those preferences now live
// in the person's profile (lib/domain/scoring/profile.ts) and shape the ORDER
// instead, so a great hybrid role can still out-rank a mediocre remote one
// rather than vanishing.
//
// What is left is navigation, not filtering:
//   bucket — which pile am I looking at (inbox / working / archive)
//   query  — find that one company I saw yesterday
//   page   — the list is long
//
// PARSING IS STILL TOTAL. Every value arrives from a query string a human can
// edit, so anything unrecognised is dropped rather than thrown on. A malformed
// URL must render a sensible page, never a stack trace, and must never reach
// SQL.
// ---------------------------------------------------------------------------

export type JobView = {
  bucket: JobBucket;
  /** Matched against title and company. Navigation, not a filter. */
  query?: string;
  /** 1-based. */
  page: number;
};

export const DEFAULT_JOB_VIEW: JobView = {
  bucket: DEFAULT_BUCKET,
  query: undefined,
  page: 1,
};

export function parseJobView(params: URLSearchParams): JobView {
  const rawPage = Number(params.get("page"));
  const page =
    Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;

  return {
    bucket: parseBucket(params.get("bucket")),
    query: params.get("q")?.trim() || undefined,
    page,
  };
}

/** Omits defaults, so the default view has an empty query string. */
export function serializeJobView(view: JobView): URLSearchParams {
  const params = new URLSearchParams();
  if (view.bucket !== DEFAULT_JOB_VIEW.bucket) params.set("bucket", view.bucket);
  if (view.query) params.set("q", view.query);
  if (view.page > 1) params.set("page", String(view.page));
  return params;
}

/**
 * Changing bucket or query resets to page 1.
 *
 * Without this, being on page 4 of Archive and clicking Inbox lands you on page
 * 4 of an inbox that may only have two pages — an empty screen that reads as
 * "you have no new jobs".
 */
export function withView(current: JobView, changes: Partial<JobView>): JobView {
  const next = { ...current, ...changes };
  const movedPile =
    changes.bucket !== undefined && changes.bucket !== current.bucket;
  const changedQuery =
    changes.query !== undefined && changes.query !== current.query;
  if ((movedPile || changedQuery) && changes.page === undefined) next.page = 1;
  return next;
}
