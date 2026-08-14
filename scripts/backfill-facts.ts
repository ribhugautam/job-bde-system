// Re-derives structured facts for stored jobs and re-scores them.
//
// Two jobs in one pass:
//   1. Repair linkedin_alert rows whose `title` is an entire mangled job card.
//   2. Derive facts for every row whose facts_version is below FACTS_VERSION,
//      then re-score it.
//
// Rows previously marked `rejected` are returned to the pipeline: many were
// rejected on a score computed from corrupt data, and leaving them rejected
// would make this fix invisible.
//
// Idempotent and safe to re-run: a row that already carries the current
// facts_version is skipped.
//
//   npm run db:backfill            (dry run - prints, changes nothing)
//   npm run db:backfill -- --write
//
// --requeue-enrich (opt-in, separate from the above):
//
//   The repair above moves every affected row to stage "score" directly, since
//   that is the correct next step for RE-SCORING it. But the stage machine
//   (JOB_STAGES in lib/pipeline/state.ts) is forward-only and nothing else ever
//   resets a row back to "enrich" - so a repaired row's company stays the
//   "Unknown" placeholder the old alert parser wrote FOREVER, even though
//   lib/infra/linkedin/enrich.ts can now recover it from the job's public page.
//   This flag is the one-time, explicit opt-in that gives those rows their
//   first (and only) shot at that recovery, by moving them back to "enrich".
//
//   Eligibility is deliberately narrow and re-run-safe:
//     - source = 'linkedin_alert' and company = 'Unknown' (nothing else is
//       missing a company because of this bug).
//     - status is 'found' or 'rejected' - a row the operator has already acted
//       on (matched, ready_for_review, applied, sent, responded, interview,
//       offer) is never requeued.
//     - the row's LinkedIn id has NO row yet in linkedin_enrich_cache. That is
//       what makes a second run safe: once a row has been through "enrich"
//       once - live fetch or cache hit, recovered a company or not - a cache
//       row exists for its id and it is never selected again. Without this
//       check a permanently-blocked (403/429) listing would be requeued and
//       re-fetched forever.
//
//   Same dry-run default as the rest of the script: prints the count, changes
//   nothing without --write.
//
//   npm run db:backfill -- --requeue-enrich             (dry run)
//   npm run db:backfill -- --requeue-enrich --write
import { eq, lt, or, isNull, and, inArray } from "drizzle-orm";
import { resolveDbTarget } from "./db-target";
import { deriveJobFacts, FACTS_VERSION } from "../lib/domain/facts";
import { repairMangledCard } from "../lib/infra/linkedin/alerts";
import { extractJobId } from "../lib/infra/linkedin/enrich";
import { scoreJob } from "../lib/domain/scoring/score";
import { factsToRow } from "../lib/pipeline/stages/ingest";
import type { RawJob } from "../lib/domain/types";

// Static import, NOT a top-level `await import(...)`. package.json has no
// `"type": "module"`, so tsx transpiles this file to CJS, and a top-level
// await there is a hard failure (ERR_REQUIRE_ASYNC_MODULE). getDb() reads
// process.env lazily inside its function body (lib/infra/db/client.ts), so a
// static import here does not capture configuration before .env is loaded -
// resolveDbTarget() is what loads it, and it is called first inside main(),
// before getDb() is ever invoked.
import { getDb, schema } from "../lib/infra/db/client";

const WRITE = process.argv.includes("--write");
const REQUEUE_ENRICH = process.argv.includes("--requeue-enrich");

/**
 * Moves eligible linkedin_alert/Unknown-company rows back to stage "enrich" -
 * see the header comment above for why this is needed and why the
 * "no cache row yet" check is what keeps it re-run-safe.
 */
async function requeueEnrich(db: ReturnType<typeof getDb>, write: boolean) {
  const candidates = await db
    .select()
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.source, "linkedin_alert"),
        eq(schema.jobs.company, "Unknown"),
        or(eq(schema.jobs.status, "found"), eq(schema.jobs.status, "rejected"))
      )
    );

  const linkedinIdByJobId = new Map<number, string>();
  for (const row of candidates) {
    const linkedinId = extractJobId(row.url);
    // A row whose URL cannot be resolved to a LinkedIn id has nothing to
    // enrich against and could never build a cache row to stop it being
    // picked up again - never requeue it.
    if (linkedinId) linkedinIdByJobId.set(row.id, linkedinId);
  }

  const linkedinIds = [...new Set(linkedinIdByJobId.values())];
  const alreadyFetched = new Set(
    linkedinIds.length
      ? (
          await db
            .select({ jobId: schema.linkedinEnrichCache.jobId })
            .from(schema.linkedinEnrichCache)
            .where(inArray(schema.linkedinEnrichCache.jobId, linkedinIds))
        ).map((r) => r.jobId)
      : []
  );

  const toRequeue = candidates.filter((row) => {
    const linkedinId = linkedinIdByJobId.get(row.id);
    return linkedinId !== undefined && !alreadyFetched.has(linkedinId);
  });

  console.log(`requeued ${toRequeue.length} linkedin_alert rows to stage=enrich`);

  if (write) {
    for (const row of toRequeue) {
      await db
        .update(schema.jobs)
        .set({
          stage: "enrich",
          attempts: 0,
          lastError: null,
          nextAttemptAt: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.jobs.id, row.id));
    }
  }
}

function tally<T extends string>(values: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

async function main() {
  // MUST run before anything calls getDb(): tsx does not load .env, and this
  // is what does. It also prints which database it resolved - the guard
  // against the documented incident where a script reported success while
  // silently operating on the local SQLite fallback instead of Turso.
  const target = resolveDbTarget();
  console.log(`Backfilling ${target.label}`);

  const db = getDb();

  const rows = await db
    .select()
    .from(schema.jobs)
    .where(or(lt(schema.jobs.factsVersion, FACTS_VERSION), isNull(schema.jobs.factsVersion)));

  console.log(`${rows.length} rows below facts_version ${FACTS_VERSION}`);
  console.log("BEFORE arrangement:", tally(rows.map((r) => r.arrangement ?? "null")));

  let repaired = 0;
  let rescored = 0;
  const after: string[] = [];
  const geoAfter: string[] = [];

  for (const row of rows) {
    let title = row.title;
    let location = row.location ?? undefined;
    let arrangement: RawJob["arrangement"];
    // Carried forward from the row so a job whose title was never mangled
    // (the common case) keeps the Easy Apply flag it was ingested with.
    // Only the repair branch below is allowed to override it - there is no
    // other way to (re)derive this fact from stored data.
    let easyApply: RawJob["easyApply"] = row.easyApply ?? undefined;

    // A card that still contains the separator is a mangled title.
    if (row.source === "linkedin_alert" && row.title.includes(" · ")) {
      const fixed = repairMangledCard(row.title);
      title = fixed.title;
      location = fixed.location ?? location;
      arrangement = fixed.arrangement;
      easyApply = fixed.easyApply;
      repaired++;
    }

    const raw: RawJob = {
      source: row.source,
      sourceId: row.sourceId,
      title,
      company: row.company,
      url: row.url,
      location,
      tags: (row.tags as string[]) ?? [],
      description: row.description ?? undefined,
      remote: row.remote ?? undefined,
      arrangement,
      easyApply,
    };

    const facts = deriveJobFacts(raw);
    const scored = scoreJob({ ...raw, ...facts, sparse: !raw.description });
    // The single source of the arrangement -> remote translation - see the
    // comment on factsToRow in lib/pipeline/stages/ingest.ts for why "unknown"
    // must become an explicit null rather than an omitted key. Renamed on
    // destructure: `arrangement` above already names the (possibly repaired)
    // INPUT fed to deriveJobFacts, and this is deriveJobFacts's OUTPUT.
    const { arrangement: derivedArrangement, remote } = factsToRow(facts);

    after.push(facts.arrangement);
    geoAfter.push(facts.geoEligibility);

    if (WRITE) {
      await db
        .update(schema.jobs)
        .set({
          title,
          location,
          arrangement: derivedArrangement,
          geoEligibility: facts.geoEligibility,
          geoRegions: facts.geoRegions,
          // deriveJobFacts leaves these undefined when the posting states no
          // requirement / the source has no evidence. drizzle's update().set()
          // DROPS keys whose value is `undefined` instead of writing NULL
          // (lib/infra/db/client.ts's getDb is lazy about env for the same
          // reason this script is careful about imports - see the top-of-file
          // note - but this particular landmine is documented in
          // node_modules/drizzle-orm/utils.cjs's mapUpdateSet). Coalescing to
          // `null` here is what actually clears a stale value instead of
          // silently leaving the old one in place.
          minYears: facts.minYears ?? null,
          maxYears: facts.maxYears ?? null,
          experienceText: facts.experienceText ?? null,
          easyApply: facts.easyApply ?? null,
          factsVersion: FACTS_VERSION,
          remote,
          score: scored.score,
          scoreReasons: scored.reasons,
          // A row rejected on a corrupt score deserves another pass. Rows the
          // operator has already acted on (sent, applied, responded) are left
          // exactly where they are.
          ...(row.status === "rejected" || row.status === "found"
            ? { status: "found" as const, stage: "score" as const, attempts: 0 }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.jobs.id, row.id));
    }
    rescored++;
  }

  console.log(`repaired ${repaired} mangled LinkedIn titles`);
  console.log(`re-scored ${rescored} rows`);
  console.log("AFTER arrangement:", tally(after));
  console.log("AFTER geo:", tally(geoAfter));

  if (REQUEUE_ENRICH) await requeueEnrich(db, WRITE);

  if (!WRITE) console.log("\nDRY RUN - nothing written. Re-run with --write to apply.");
}

main().catch((err) => {
  console.error("BACKFILL FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
