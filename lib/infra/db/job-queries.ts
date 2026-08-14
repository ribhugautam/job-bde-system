import { and, count, desc, eq, gte, inArray, like, ne, or, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";
import type { JobFilters } from "@/lib/domain/jobs/filters";

// ---------------------------------------------------------------------------
// The only place that knows how a JobFilters becomes SQL.
//
// Filtering runs here rather than in the browser because the table grows: 695
// rows today, and shipping every row to the client to filter it there degrades
// with the pipeline's success. This also finally exercises `jobs_facts_idx`,
// the (geo_eligibility, arrangement, score) index Phase 1 added and left unused.
// ---------------------------------------------------------------------------

type Db = ReturnType<typeof drizzle<typeof schema>>;

/** Every condition is AND-ed; an empty list means "no constraint on this axis". */
export function jobFilterConditions(filters: JobFilters): SQL[] {
  const conditions: SQL[] = [];

  if (!filters.showDismissed) {
    conditions.push(ne(schema.jobs.status, "ignored"));
  }
  if (filters.eligibility.length) {
    conditions.push(inArray(schema.jobs.geoEligibility, filters.eligibility));
  }
  if (filters.arrangement.length) {
    conditions.push(inArray(schema.jobs.arrangement, filters.arrangement));
  }
  if (filters.sources.length) {
    conditions.push(inArray(schema.jobs.source, filters.sources));
  }
  if (filters.minScore !== undefined) {
    conditions.push(gte(schema.jobs.score, filters.minScore));
  }
  if (filters.easyApplyOnly) {
    conditions.push(eq(schema.jobs.easyApply, true));
  }
  if (filters.query) {
    // SQLite's LIKE is case-insensitive for ASCII by default. The wildcards are
    // added here rather than accepted from the user, so a query containing % or
    // _ narrows the search instead of widening it unexpectedly.
    const needle = `%${filters.query}%`;
    const match = or(like(schema.jobs.title, needle), like(schema.jobs.company, needle));
    if (match) conditions.push(match);
  }

  return conditions;
}

export async function fetchFilteredJobs(
  db: Db,
  filters: JobFilters,
  limit: number
): Promise<{ rows: (typeof schema.jobs.$inferSelect)[]; total: number }> {
  const conditions = jobFilterConditions(filters);
  const where = conditions.length ? and(...conditions) : undefined;

  // Both sorts end on `id` because neither key is unique. Feed-sourced dates
  // are day-granular, so a shared postedAt is common — without the tiebreak
  // SQLite is free to return tied rows in any order, and the list reshuffles
  // between renders of the same query.
  const order =
    filters.sort === "newest"
      ? [
          desc(sql`coalesce(${schema.jobs.postedAt}, ${schema.jobs.fetchedAt})`),
          desc(schema.jobs.id),
        ]
      : [desc(schema.jobs.score), desc(schema.jobs.id)];

  const [rows, totals] = await Promise.all([
    db.select().from(schema.jobs).where(where).orderBy(...order).limit(limit),
    db.select({ n: count() }).from(schema.jobs).where(where),
  ]);

  return { rows, total: totals[0]?.n ?? 0 };
}

/**
 * The sources the filter bar offers, commonest first. Lives here rather than in
 * the page because this module is the only one that should know the schema —
 * and because a source list built from the data cannot drift from it the way a
 * hardcoded array would when a source is added or renamed.
 */
export async function fetchJobSources(db: Db): Promise<string[]> {
  const rows = await db
    .select({ source: schema.jobs.source, n: count() })
    .from(schema.jobs)
    .groupBy(schema.jobs.source)
    .orderBy(desc(count()));
  return rows.map((r) => r.source);
}
