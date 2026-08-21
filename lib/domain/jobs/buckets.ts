// ---------------------------------------------------------------------------
// Inbox / Working / Archive. Pure: no database, no React.
//
// This replaces a job list that had no notion of old versus new at all. There
// was a "newest first" sort and a "show dismissed" toggle, and nothing else —
// so a posting from six weeks ago (almost certainly filled) rendered
// identically to one from this morning, and the table grew forever.
//
// THE DESIGN DECISION, because it is what makes the rest cheap: buckets are
// DERIVED, never stored. A job_user_state row is written only when a person
// actually acts on a job. Consequences:
//
//   - A new colleague signs in to a fully ranked inbox with zero rows written
//     for them. No backfill, no users x jobs explosion.
//   - Auto-expiry costs nothing. Staleness is a date comparison at read time,
//     not a sweep job that has to run and can fall behind.
//   - JOB_STALE_DAYS can be changed at any time and every bucket reflows
//     instantly, in both directions. Nothing to migrate, nothing to undo.
//
// A stored bucket column would need all three of those solved by hand.
// ---------------------------------------------------------------------------

export const JOB_BUCKETS = ["inbox", "working", "archive"] as const;
export type JobBucket = (typeof JOB_BUCKETS)[number];

export const DEFAULT_BUCKET: JobBucket = "inbox";

export function parseBucket(raw: string | null | undefined): JobBucket {
  return (JOB_BUCKETS as readonly string[]).includes(raw ?? "")
    ? (raw as JobBucket)
    : DEFAULT_BUCKET;
}

/**
 * Statuses meaning "I have picked this up". Everything from deciding it is a
 * match through to an offer.
 *
 * `found` is deliberately absent: it is the status every job starts at, so
 * treating it as "working" would put the entire backlog in that bucket and
 * leave the inbox permanently empty.
 */
export const WORKING_STATUSES: readonly string[] = [
  "matched",
  "ready_for_review",
  "applied",
  "sent",
  "responded",
  "interview",
  "offer",
];

/** Statuses meaning "I am done with this", however it ended. */
export const ARCHIVED_STATUSES: readonly string[] = [
  "ignored",
  "rejected",
  "closed",
];

export type JobAge = {
  postedAt: Date | null;
  fetchedAt: Date | null;
};

/**
 * How old a posting is, preferring when it was POSTED over when we happened to
 * fetch it. A job first seen today because a new source was switched on may
 * have been advertised for two months, and fetch time would call it brand new.
 */
export function effectiveDate(age: JobAge): Date | null {
  return age.postedAt ?? age.fetchedAt ?? null;
}

/**
 * Whether a posting is old enough to stop showing in the inbox.
 *
 * A job with NO date at all counts as fresh. Erring toward visible is right
 * here: hiding something because we do not know its age is a silent loss, and
 * the cost of the opposite mistake is one row the reader skips past.
 */
export function isStale(age: JobAge, now: Date, staleDays: number): boolean {
  const date = effectiveDate(age);
  if (!date) return false;
  const ageMs = now.getTime() - date.getTime();
  return ageMs >= staleDays * 24 * 60 * 60 * 1000;
}

export type UserJobState = { status: string } | null;

/**
 * Which bucket a job sits in FOR ONE PERSON.
 *
 * Order matters. An explicit status always wins over age: a job somebody
 * applied to two months ago belongs in Working, not swept into Archive for
 * being old. Only an untriaged job can expire.
 */
export function deriveBucket(opts: {
  state: UserJobState;
  age: JobAge;
  now: Date;
  staleDays: number;
}): JobBucket {
  const status = opts.state?.status;

  if (status && ARCHIVED_STATUSES.includes(status)) return "archive";
  if (status && WORKING_STATUSES.includes(status)) return "working";

  // No state row, or a row still sitting at `found`: untriaged. This is the
  // only case age is allowed to decide.
  return isStale(opts.age, opts.now, opts.staleDays) ? "archive" : "inbox";
}

/** Why a job is in Archive, so the UI can distinguish giving up from timing out. */
export function archiveReason(opts: {
  state: UserJobState;
  age: JobAge;
  now: Date;
  staleDays: number;
}): "dismissed" | "expired" | null {
  const status = opts.state?.status;
  if (status && ARCHIVED_STATUSES.includes(status)) return "dismissed";
  if (
    (!status || !WORKING_STATUSES.includes(status)) &&
    isStale(opts.age, opts.now, opts.staleDays)
  ) {
    return "expired";
  }
  return null;
}

/**
 * Whether a job arrived since this person last looked, for the "new" marker.
 *
 * Null lastSeenAt means they have never looked, and NOTHING is marked new —
 * flagging all 700 rows on a first visit says nothing at all.
 */
export function isNewSince(age: JobAge, lastSeenAt: Date | null): boolean {
  if (!lastSeenAt) return false;
  const date = age.fetchedAt ?? age.postedAt;
  if (!date) return false;
  return date.getTime() > lastSeenAt.getTime();
}
