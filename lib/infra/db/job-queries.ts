import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";
import type { JobView } from "@/lib/domain/jobs/filters";
import {
  ARCHIVED_STATUSES,
  WORKING_STATUSES,
  archiveReason,
  isNewSince,
  type JobBucket,
} from "@/lib/domain/jobs/buckets";
import { scoreJob } from "@/lib/domain/scoring/score";
import type { ScoringProfile } from "@/lib/domain/scoring/profile";
import type { RawJob } from "@/lib/domain/types";

// ---------------------------------------------------------------------------
// Reading the job list for ONE person.
//
// Two things happen here that used to be simple, and it is worth being explicit
// about why each is worth its cost.
//
// 1. BUCKETS ARE A LEFT JOIN, not a column. There is no per-user row for an
//    untriaged job (see lib/domain/jobs/buckets.ts), so "my inbox" is "jobs
//    with no state row of mine, or one still at `found`, that are not stale".
//    The join is against an index on (user_id, status).
//
// 2. SCORES ARE COMPUTED AT READ TIME, not stored per user per job.
//    scoreJob() is pure token matching and runs in microseconds, so ranking a
//    couple of thousand rows costs single-digit milliseconds. In exchange:
//    editing a profile re-ranks instantly with no rescore job, there is no
//    users x jobs table to backfill for every new colleague, and a whole class
//    of "the stored score is stale" bug cannot exist.
//
//    That trade stops paying somewhere past the cap below, at which point
//    ordering has to move into SQL against a materialised column.
// ---------------------------------------------------------------------------

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * The most rows that will be pulled into memory to be ranked.
 *
 * Sorting by a computed score means every candidate row must be scored before
 * the first page can be shown — there is no way to order in SQL by a number
 * that does not exist there. At ~72 new jobs a day and a 30-day inbox window
 * the real figure is nearer 2,000, so this is roughly a 5x headroom rather
 * than a limit anyone should hit.
 *
 * It is a HARD cap, and when it bites the UI says so rather than silently
 * showing a truncated ranking — see `truncated` in RankedJobs.
 */
export const MAX_RANKED_ROWS = 10_000;

export type RankedJob = {
  job: typeof schema.jobs.$inferSelect;
  score: number;
  reasons: string[];
  /** This person's status, or null when they have not touched it. */
  userStatus: string | null;
  /** Only meaningful in the archive bucket. */
  archivedBecause: "dismissed" | "expired" | null;
  isNew: boolean;
};

export type RankedJobs = {
  rows: RankedJob[];
  /** Total matching this bucket + query, before pagination. */
  total: number;
  /** True when the cap above stopped us reading every candidate row. */
  truncated: boolean;
  counts: Record<JobBucket, number>;
};

/** Turns a stored row into the shape the pure scorer expects. */
function toRawJob(job: typeof schema.jobs.$inferSelect): RawJob {
  return {
    source: job.source,
    sourceId: job.sourceId,
    title: job.title,
    company: job.company,
    companyUrl: job.companyUrl ?? undefined,
    url: job.url,
    applyEmail: job.applyEmail ?? undefined,
    location: job.location ?? undefined,
    remote: job.remote ?? undefined,
    arrangement: (job.arrangement as RawJob["arrangement"]) ?? undefined,
    geoEligibility: (job.geoEligibility as RawJob["geoEligibility"]) ?? undefined,
    geoRegions: (job.geoRegions as string[]) ?? [],
    minYears: job.minYears ?? undefined,
    maxYears: job.maxYears ?? undefined,
    experienceText: job.experienceText ?? undefined,
    easyApply: job.easyApply ?? undefined,
    salaryText: job.salaryText ?? undefined,
    tags: (job.tags as string[]) ?? [],
    description: job.description ?? undefined,
    postedAt: job.postedAt ?? undefined,
    sparse: !job.description,
  };
}

/**
 * The SQL half of a bucket.
 *
 * Age is compared with `coalesce(posted_at, fetched_at)`, preferring when a job
 * was ADVERTISED over when we happened to fetch it — a job first seen today
 * because a source was switched on may have been open for two months.
 */
function bucketCondition(
  bucket: JobBucket,
  staleCutoffSeconds: number
): SQL | undefined {
  // UNIX SECONDS, not a Date, and not milliseconds. Timestamp columns are
  // stored as seconds (see the mapping note at the top of schema.ts). Drizzle
  // converts automatically when it knows the column, but `coalesce(...)` is a
  // raw expression it cannot type -- so binding a Date here compares seconds
  // against milliseconds, every job looks ~55 years old, and the entire inbox
  // silently reports as expired.
  const effective = sql`coalesce(${schema.jobs.postedAt}, ${schema.jobs.fetchedAt})`;
  const untriaged = or(
    isNull(schema.jobUserState.status),
    eq(schema.jobUserState.status, "found")
  );

  // A job with NO date at all counts as FRESH, and the null has to be spelled
  // out on both sides. In SQL `NULL >= x` and `NULL < x` are both NULL, i.e.
  // both falsy -- so without these a dateless row would match neither the inbox
  // condition nor the archive one and disappear from the app entirely. Rare
  // (fetched_at has a default) but silent, which is the bad combination. This
  // also keeps the SQL agreeing with isStale() in the domain module, which
  // treats an unknown age as fresh on the same reasoning: hiding something
  // because we do not know its age is a loss, showing it costs one skipped row.
  const fresh = or(isNull(effective), gte(effective, staleCutoffSeconds));
  const expired = and(sql`${effective} is not null`, lt(effective, staleCutoffSeconds));

  switch (bucket) {
    case "inbox":
      return and(untriaged, fresh);
    case "working":
      return inArray(schema.jobUserState.status, [...WORKING_STATUSES]);
    case "archive":
      // Two different ways to land here: the person gave up on it, or nobody
      // ever triaged it and it timed out.
      return or(
        inArray(schema.jobUserState.status, [...ARCHIVED_STATUSES]),
        and(untriaged, expired)
      );
  }
}

function searchCondition(query: string | undefined): SQL | undefined {
  if (!query) return undefined;

  // SQLite's LIKE is case-insensitive for ASCII by default.
  //
  // The user's own % and _ are ESCAPED so they match literally. Simply wrapping
  // the input in %...% does NOT achieve that — an inherited comment here
  // claimed it did, and it is not true: LIKE treats every % in the pattern as a
  // wildcard whoever put it there, so searching for "%" matched the entire
  // table rather than the nothing a reader would expect. Not a security hole
  // (the pattern is still a bound parameter) but wrong, and wrong in the
  // direction of "my search silently did nothing".
  const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
  const needle = `%${escaped}%`;
  return or(
    sql`${schema.jobs.title} like ${needle} escape '\\'`,
    sql`${schema.jobs.company} like ${needle} escape '\\'`
  );
}

export async function fetchRankedJobs(opts: {
  db: Db;
  userId: number;
  view: JobView;
  profile: ScoringProfile;
  staleDays: number;
  pageSize: number;
  lastSeenAt: Date | null;
  now?: Date;
}): Promise<RankedJobs> {
  const { db, userId, view, profile, staleDays, pageSize, lastSeenAt } = opts;
  const now = opts.now ?? new Date();
  const staleCutoffSeconds = Math.floor(
    (now.getTime() - staleDays * 24 * 60 * 60 * 1000) / 1000
  );

  // LEFT JOIN, not INNER: the common case is a job this person has never
  // touched, which has no state row at all. An inner join would return an
  // empty inbox for every new colleague.
  const base = db
    .select({ job: schema.jobs, status: schema.jobUserState.status })
    .from(schema.jobs)
    .leftJoin(
      schema.jobUserState,
      and(
        eq(schema.jobUserState.jobId, schema.jobs.id),
        eq(schema.jobUserState.userId, userId)
      )
    );

  const conditions = [
    bucketCondition(view.bucket, staleCutoffSeconds),
    searchCondition(view.query),
  ].filter(Boolean) as SQL[];

  const candidates = await base
    .where(conditions.length ? and(...conditions) : undefined)
    // Recency, purely so that IF the cap bites we keep the newest rows rather
    // than an arbitrary slice. The real ordering is by score, below.
    .orderBy(
      desc(sql`coalesce(${schema.jobs.postedAt}, ${schema.jobs.fetchedAt})`),
      desc(schema.jobs.id)
    )
    .limit(MAX_RANKED_ROWS + 1);

  const truncated = candidates.length > MAX_RANKED_ROWS;
  const usable = truncated ? candidates.slice(0, MAX_RANKED_ROWS) : candidates;

  const ranked: RankedJob[] = usable.map(({ job, status }) => {
    const { score, reasons } = scoreJob(toRawJob(job), profile);
    const age = { postedAt: job.postedAt, fetchedAt: job.fetchedAt };
    return {
      job,
      score,
      reasons,
      userStatus: status ?? null,
      archivedBecause:
        view.bucket === "archive"
          ? archiveReason({ state: status ? { status } : null, age, now, staleDays })
          : null,
      isNew: isNewSince(age, lastSeenAt),
    };
  });

  // Score first, then id, because score is not unique. Without the tiebreak
  // SQLite is free to hand back tied rows in any order and the list reshuffles
  // between renders of the same query.
  ranked.sort((a, b) => b.score - a.score || b.job.id - a.job.id);

  const start = (view.page - 1) * pageSize;
  return {
    rows: ranked.slice(start, start + pageSize),
    total: ranked.length,
    truncated,
    counts: await fetchBucketCounts(db, userId, staleCutoffSeconds),
  };
}

/**
 * How many jobs sit in each bucket, for the tab labels.
 *
 * Counted in SQL rather than by ranking every bucket: the numbers do not
 * depend on score, and scoring three bucketfuls to display three integers
 * would triple the cost of every page load.
 */
export async function fetchBucketCounts(
  db: Db,
  userId: number,
  staleCutoffSeconds: number
): Promise<Record<JobBucket, number>> {
  const rows = await db
    .select({
      status: schema.jobUserState.status,
      fresh: sql<number>`case when coalesce(${schema.jobs.postedAt}, ${schema.jobs.fetchedAt}) >= ${staleCutoffSeconds} then 1 else 0 end`,
      n: sql<number>`count(*)`,
    })
    .from(schema.jobs)
    .leftJoin(
      schema.jobUserState,
      and(
        eq(schema.jobUserState.jobId, schema.jobs.id),
        eq(schema.jobUserState.userId, userId)
      )
    )
    .groupBy(schema.jobUserState.status, sql`2`);

  const counts: Record<JobBucket, number> = { inbox: 0, working: 0, archive: 0 };
  for (const row of rows) {
    const n = Number(row.n) || 0;
    const status = row.status;
    if (status && ARCHIVED_STATUSES.includes(status)) counts.archive += n;
    else if (status && WORKING_STATUSES.includes(status)) counts.working += n;
    else if (row.fresh) counts.inbox += n;
    else counts.archive += n;
  }
  return counts;
}
