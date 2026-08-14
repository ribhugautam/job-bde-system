import { eq, gte, inArray } from "drizzle-orm";
import { schema } from "@/lib/infra/db/client";
import {
  enrichSettings,
  extractJobId,
  fetchJobDescription,
  sleep,
} from "@/lib/infra/linkedin/enrich";
import type { StageContext, StageResult } from "../context";
import { claimJobs, failJob } from "./claim";

// ---------------------------------------------------------------------------
// Enrich: recover the job description that alert emails do not carry.
//
// This is what removed the old dual-threshold hack. LinkedIn alert emails give
// a title, company and link but no description, so those jobs could only ever
// be scored on their title and needed a separate, lower bar to survive at all.
// Fetching the public page puts them on the same evidence footing as every
// other source, and one threshold then works for everything.
//
// Three properties this stage must hold:
//
//   1. NEVER FATAL. A blocked or missing page moves the job on to scoring
//      title-only, which is exactly the behavior that existed before. Enrichment
//      is an improvement, not a dependency.
//   2. CACHED, INCLUDING FAILURES. A 404 or a 429 is remembered, so the daily
//      request count tracks new alerts rather than the size of the backlog.
//      Without this, a growing queue of un-enrichable jobs would re-hammer
//      LinkedIn on every single run.
//   3. PACED AND CAPPED. Requests are spaced and bounded per day, so a large
//      first run cannot turn into a burst.
// ---------------------------------------------------------------------------

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function runEnrich(ctx: StageContext): Promise<StageResult> {
  const limit = ctx.env.WORKER_BATCH_SIZE;
  const jobs = await claimJobs(ctx, "enrich", limit);
  if (jobs.length === 0) return { processed: 0, hasMore: false };

  const settings = enrichSettings();
  let processed = 0;

  // Enrichment off: pass everything straight through to scoring rather than
  // leaving rows stranded in a stage that will never run.
  if (!settings.enabled) {
    await ctx.db
      .update(schema.jobs)
      .set({ stage: "score", updatedAt: new Date() })
      .where(
        inArray(
          schema.jobs.id,
          jobs.map((j) => j.id)
        )
      );
    return { processed: jobs.length, hasMore: jobs.length === limit };
  }

  // --- Warm the cache for this batch in one query -------------------------
  const idByJob = new Map<number, string>();
  for (const job of jobs) {
    const linkedinId = extractJobId(job.url);
    if (linkedinId) idByJob.set(job.id, linkedinId);
  }

  const linkedinIds = [...new Set(idByJob.values())];
  const cachedRows = linkedinIds.length
    ? await ctx.db
        .select()
        .from(schema.linkedinEnrichCache)
        .where(inArray(schema.linkedinEnrichCache.jobId, linkedinIds))
    : [];
  const cache = new Map(cachedRows.map((r) => [r.jobId, r]));

  // --- How many live fetches are still allowed today ----------------------
  const fetchedToday = await ctx.db
    .select({ jobId: schema.linkedinEnrichCache.jobId })
    .from(schema.linkedinEnrichCache)
    .where(gte(schema.linkedinEnrichCache.fetchedAt, startOfToday()));
  let remainingBudget = Math.max(0, settings.dailyCap - fetchedToday.length);

  let capReported = false;
  let isFirstFetch = true;

  for (const job of jobs) {
    // Stop cleanly if the clock runs low mid-batch. Whatever is left keeps
    // stage 'enrich' and is picked up next invocation — that resumability is
    // the whole reason enrichment can afford to be slow and polite.
    if (!ctx.deadline.hasBudget(settings.delayMs + 5_000)) break;

    try {
      const linkedinId = idByJob.get(job.id);

      // Not a LinkedIn URL, so there is nothing to enrich from. Move on.
      if (!linkedinId) {
        await advance(ctx, job.id, undefined, undefined);
        processed++;
        continue;
      }

      const cached = cache.get(linkedinId);
      if (cached) {
        // Same guard as the live-fetch path below: a cached company is only
        // ever offered when the stored company is still the "Unknown"
        // placeholder. A cache hit must not overwrite a company a source
        // stated correctly, exactly like a live fetch must not.
        const recoveredCompany =
          cached.company && job.company === "Unknown" ? cached.company : undefined;
        await advance(
          ctx,
          job.id,
          cached.outcome === "ok" ? cached.description ?? undefined : undefined,
          cached.outcome === "ok" ? "linkedin_public" : undefined,
          recoveredCompany
        );
        if (cached.outcome === "ok" && cached.description) {
          ctx.counters.jobsEnriched++;
        }
        processed++;
        continue;
      }

      if (remainingBudget <= 0) {
        if (!capReported) {
          ctx.errors.push(
            `linkedin enrich: daily cap of ${settings.dailyCap} reached; ` +
              `remaining jobs stay title-only until tomorrow`
          );
          capReported = true;
        }
        // Deliberately NOT advanced: leave the row in 'enrich' so tomorrow's
        // run can still recover its description. Advancing it now would score
        // it title-only and permanently lose the chance.
        break;
      }

      // Pace between live fetches only — cache hits above are free and must not
      // be slowed down by a sleep they do not need.
      if (!isFirstFetch) await sleep(settings.delayMs);
      isFirstFetch = false;

      const result = await fetchJobDescription(linkedinId);
      remainingBudget--;

      await ctx.db
        .insert(schema.linkedinEnrichCache)
        .values({
          jobId: linkedinId,
          description: result.description,
          company: result.company,
          outcome: result.outcome,
          httpStatus: result.httpStatus,
          fetchedAt: new Date(),
        })
        .onConflictDoNothing();

      // Only offered when the stored company is the "Unknown" placeholder the
      // old alert parser wrote. A company a source stated correctly is never
      // overwritten by a scraped one.
      const recoveredCompany =
        result.company && job.company === "Unknown" ? result.company : undefined;

      if (result.outcome === "ok" && result.description) {
        ctx.counters.jobsEnriched++;
        await advance(ctx, job.id, result.description, "linkedin_public", recoveredCompany);
      } else {
        // Blocked, gone, or broken. Score it on the title and carry on; this is
        // a degraded result, not a failure worth retrying against a backoff.
        // A company may still have been recovered even with no description.
        await advance(ctx, job.id, undefined, undefined, recoveredCompany);
      }
      processed++;
    } catch (err) {
      await failJob(ctx, job.id, job.attempts, err);
    }
  }

  return { processed, hasMore: jobs.length === limit };
}

async function advance(
  ctx: StageContext,
  jobId: number,
  description: string | undefined,
  descriptionSource: string | undefined,
  company?: string
) {
  await ctx.db
    .update(schema.jobs)
    .set({
      ...(description ? { description, descriptionSource } : {}),
      ...(company ? { company } : {}),
      stage: "score",
      attempts: 0,
      lastError: null,
      nextAttemptAt: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.jobs.id, jobId));
}
