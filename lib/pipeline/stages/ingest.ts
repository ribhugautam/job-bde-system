import { inArray } from "drizzle-orm";
import { schema } from "@/lib/infra/db/client";
import { fetchAllJobs, fetchAllLeads } from "@/lib/infra/sources";
import {
  fingerprintJob,
  fingerprintLead,
  pickRicherDescription,
} from "@/lib/domain/dedupe/fingerprint";
import { deriveJobFacts, deriveExperience, FACTS_VERSION } from "@/lib/domain/facts";
import type { ExperienceFacts, JobFacts, WorkArrangement } from "@/lib/domain/facts";
import type { RawJob, RawLead } from "@/lib/domain/types";
import { recordError, type StageContext, type StageResult } from "../context";

// ---------------------------------------------------------------------------
// Ingest: every source -> deduped rows.
//
// Two levels of de-duplication, and they solve different problems:
//
//   (source, source_id)  — the same listing seen twice from the SAME board,
//                          e.g. across consecutive runs. Handled by a unique
//                          index and ON CONFLICT DO NOTHING, so it is enforced
//                          by the database and survives a retried run. The old
//                          code did this with one SELECT per listing, which was
//                          both an N+1 over stateless HTTP and only correct
//                          because nothing retried it.
//
//   fingerprint          — the same real-world vacancy seen on DIFFERENT boards.
//                          Not a uniqueness constraint (two genuinely distinct
//                          roles can legitimately collide), so it is resolved in
//                          code by merging into the row that already exists.
//
// Without the second, turning on LinkedIn alerts alongside Himalayas and Jobicy
// reliably produces three rows, three scores and three cover letters for one job.
// ---------------------------------------------------------------------------

/** Kept modest: libSQL sends statements over HTTP and huge multi-row INSERTs
 *  serialize badly. 50 is comfortably inside SQLite's variable limit too. */
const CHUNK = 50;

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function runIngest(ctx: StageContext): Promise<StageResult> {
  const [jobResult, leadResult] = await Promise.all([
    fetchAllJobs(),
    fetchAllLeads(),
  ]);

  ctx.errors.push(...jobResult.errors, ...leadResult.errors);

  // A disabled source is reported, not hidden — "Adzuna found nothing" and
  // "Adzuna has no API key" must never look the same. But it is a NOTICE, not
  // an error: a source you deliberately switched off is working as configured,
  // and counting it as a failure hides the sources that genuinely broke.
  for (const skipped of [...jobResult.skipped, ...leadResult.skipped]) {
    ctx.notices.push(`source off - ${skipped}`);
  }

  const processedJobs = await ingestJobs(ctx, jobResult.jobs);
  const processedLeads = await ingestLeads(ctx, leadResult.leads);

  // Ingest always completes its fetch in one call; there is no partial state to
  // resume, so hasMore is always false.
  return { processed: processedJobs + processedLeads, hasMore: false };
}

/**
 * Translates derived facts into the two columns that decide remoteness.
 *
 * This is the exact seam where the original bug lived: `raw.remote ?? true`
 * (plus a `.default(true)` on the column, kept for reasons documented on the
 * column itself) silently overwrote a deliberate tri-state and made every one
 * of 623 stored rows claim to be remote. `remote` is now an honest derivative
 * of `arrangement`, never defaulted — `unknown` becomes `null`, not `true`.
 */
export function factsToRow(
  facts: JobFacts
): { arrangement: WorkArrangement; remote: boolean | null } {
  return {
    arrangement: facts.arrangement,
    remote:
      facts.arrangement === "unknown" ? null : facts.arrangement === "remote",
  };
}

/**
 * Decides what experience facts a cross-source merge should write, if any.
 *
 * Only experience is re-derived on a merge. `deriveExperience` scans the
 * DESCRIPTION, and description is exactly what `pickRicherDescription` can
 * replace mid-merge — a row merged from a thin listing into a full one can
 * gain text ("8+ years required") that the stale `minYears`/`maxYears`,
 * derived from the thin original, never saw. `arrangement`/`geoEligibility`/
 * `geoRegions` read only `location`/`tags`/`remote` — a merge never changes
 * those — and `easyApply`/`factsVersion` are not description-derived at all,
 * so none of them are touched here. Re-deriving arrangement/geo from the
 * CANDIDATE's location was considered and rejected: it could overwrite a
 * value correctly derived from the EXISTING row's location, a regression
 * risk with no compensating benefit, since neither fact reads the
 * description that a merge actually changes.
 *
 * Returns `undefined` when the merge gained no new description text — no new
 * evidence means nothing to re-derive, and the caller must leave the stored
 * experience fields exactly as they are.
 */
export function mergeExperienceFacts(
  candidateTitle: string,
  mergedDescription: string | undefined,
  gainedDescription: boolean
): ExperienceFacts | undefined {
  if (!gainedDescription) return undefined;
  return deriveExperience(
    [candidateTitle, mergedDescription].filter(Boolean).join("\n")
  );
}

async function ingestJobs(
  ctx: StageContext,
  raws: RawJob[]
): Promise<number> {
  const { db } = ctx;
  if (raws.length === 0) return 0;

  // --- 1. Collapse duplicates WITHIN this batch --------------------------
  // Two sources in the same run can carry the same vacancy. Merging here means
  // only one row is ever offered to the database, so the fingerprint merge below
  // deals only with rows already persisted.
  const byFingerprint = new Map<string, RawJob & { fingerprint: string; contributing: string[] }>();
  for (const raw of raws) {
    const fingerprint = fingerprintJob(raw);
    const existing = byFingerprint.get(fingerprint);
    if (!existing) {
      byFingerprint.set(fingerprint, {
        ...raw,
        fingerprint,
        contributing: [raw.source],
      });
      continue;
    }
    ctx.counters.duplicatesMerged++;
    existing.description = pickRicherDescription(
      existing.description,
      raw.description
    );
    // An apply-by-email address is the difference between auto-send and a manual
    // click, so take one from whichever source published it.
    existing.applyEmail = existing.applyEmail || raw.applyEmail;
    existing.salaryText = existing.salaryText || raw.salaryText;
    if (!existing.contributing.includes(raw.source)) {
      existing.contributing.push(raw.source);
    }
  }

  const candidates = [...byFingerprint.values()];

  // --- 2. Merge into rows that already exist under another source ---------
  const fingerprints = candidates.map((c) => c.fingerprint);
  const existingRows = fingerprints.length
    ? (
        await Promise.all(
          chunked(fingerprints, CHUNK).map((batch) =>
            db
              .select({
                id: schema.jobs.id,
                fingerprint: schema.jobs.fingerprint,
                source: schema.jobs.source,
                sourceId: schema.jobs.sourceId,
                description: schema.jobs.description,
                applyEmail: schema.jobs.applyEmail,
                sources: schema.jobs.sources,
              })
              .from(schema.jobs)
              .where(inArray(schema.jobs.fingerprint, batch))
          )
        )
      ).flat()
    : [];

  const existingByFingerprint = new Map(
    existingRows.map((r) => [r.fingerprint ?? "", r])
  );

  const toInsert: (RawJob & { fingerprint: string; contributing: string[] })[] = [];

  for (const candidate of candidates) {
    const existing = existingByFingerprint.get(candidate.fingerprint);
    if (!existing) {
      toInsert.push(candidate);
      continue;
    }

    // Same source AND same id means the unique index already covers it — this
    // is simply a listing we have seen before, not a cross-source duplicate.
    if (
      existing.source === candidate.source &&
      existing.sourceId === candidate.sourceId
    ) {
      continue;
    }

    // A genuine cross-source duplicate. Enrich the row we already have rather
    // than creating a second one.
    const mergedSources = Array.from(
      new Set([...(existing.sources ?? []), existing.source, ...candidate.contributing])
    );
    const richer = pickRicherDescription(
      existing.description ?? undefined,
      candidate.description
    );
    const gainedDescription = richer !== (existing.description ?? undefined);
    const experienceFacts = mergeExperienceFacts(
      candidate.title,
      richer,
      gainedDescription
    );

    try {
      await db
        .update(schema.jobs)
        .set({
          description: richer,
          applyEmail: existing.applyEmail || candidate.applyEmail,
          sources: mergedSources,
          descriptionSource: gainedDescription
            ? `merged:${candidate.source}`
            : undefined,
          updatedAt: new Date(),
          // A row that gained a description deserves rescoring: it was
          // previously judged on a title alone and may now clear the threshold.
          ...(gainedDescription ? { stage: "score" as const } : {}),
          // Experience facts are re-derived from the same evidence that just
          // changed (see mergeExperienceFacts). Written as explicit `null`
          // rather than left as `undefined` when absent, because drizzle's
          // update builder silently DROPS any key whose value is `undefined`
          // from the SQL SET clause (mapUpdateSet in drizzle-orm/utils) —
          // passing `undefined` here would leave a stale value from the thin
          // original in place instead of clearing it, which is the exact bug
          // this fix exists to close.
          ...(experienceFacts
            ? {
                minYears: experienceFacts.minYears ?? null,
                maxYears: experienceFacts.maxYears ?? null,
                experienceText: experienceFacts.experienceText ?? null,
              }
            : {}),
        })
        .where(inArray(schema.jobs.id, [existing.id]));
      ctx.counters.duplicatesMerged++;
    } catch (err) {
      recordError(ctx, `merge job ${existing.id}`, err);
    }
  }

  // --- 3. Insert the genuinely new ----------------------------------------
  let inserted = 0;
  for (const batch of chunked(toInsert, CHUNK)) {
    try {
      const rows = await db
        .insert(schema.jobs)
        .values(
          batch.map((raw) => {
            const facts = deriveJobFacts(raw);
            const { arrangement, remote } = factsToRow(facts);
            return {
              source: raw.source,
              sourceId: raw.sourceId,
              title: raw.title,
              company: raw.company,
              companyUrl: raw.companyUrl,
              url: raw.url,
              applyEmail: raw.applyEmail,
              location: raw.location,
              // Honest, and derived rather than defaulted — see factsToRow above.
              remote,
              arrangement,
              geoEligibility: facts.geoEligibility,
              geoRegions: facts.geoRegions,
              minYears: facts.minYears,
              maxYears: facts.maxYears,
              experienceText: facts.experienceText,
              easyApply: facts.easyApply,
              factsVersion: FACTS_VERSION,
              salaryText: raw.salaryText,
              tags: raw.tags || [],
              description: raw.description,
              postedAt: raw.postedAt,
              fingerprint: raw.fingerprint,
              sources: raw.contributing,
              descriptionSource: raw.description ? "source" : undefined,
              status: "found" as const,
              // A job that already has a description skips straight to scoring;
              // only the description-less ones need the enrichment stage.
              stage: raw.description ? ("score" as const) : ("enrich" as const),
            };
          })
        )
        // The unique index is the authority. Anything already stored is simply
        // skipped, which is what makes a retried run safe.
        .onConflictDoNothing()
        .returning({ id: schema.jobs.id });
      inserted += rows.length;
    } catch (err) {
      recordError(ctx, "insert jobs", err);
    }
  }

  ctx.counters.newJobs += inserted;
  return inserted;
}

async function ingestLeads(
  ctx: StageContext,
  raws: RawLead[]
): Promise<number> {
  const { db } = ctx;
  if (raws.length === 0) return 0;

  const byFingerprint = new Map<
    string,
    RawLead & { fingerprint: string; contributing: string[] }
  >();
  for (const raw of raws) {
    const fingerprint = fingerprintLead(raw);
    const existing = byFingerprint.get(fingerprint);
    if (!existing) {
      byFingerprint.set(fingerprint, {
        ...raw,
        fingerprint,
        contributing: [raw.source],
      });
      continue;
    }
    ctx.counters.duplicatesMerged++;
    existing.description = pickRicherDescription(
      existing.description,
      raw.description
    );
    existing.contactEmail = existing.contactEmail || raw.contactEmail;
    existing.budgetText = existing.budgetText || raw.budgetText;
    if (!existing.contributing.includes(raw.source)) {
      existing.contributing.push(raw.source);
    }
  }

  let inserted = 0;
  for (const batch of chunked([...byFingerprint.values()], CHUNK)) {
    try {
      const rows = await db
        .insert(schema.leads)
        .values(
          batch.map((raw) => ({
            source: raw.source,
            sourceId: raw.sourceId,
            title: raw.title,
            clientOrCompany: raw.clientOrCompany,
            url: raw.url,
            contactEmail: raw.contactEmail,
            budgetText: raw.budgetText,
            description: raw.description,
            postedAt: raw.postedAt,
            fingerprint: raw.fingerprint,
            sources: raw.contributing,
            status: "found" as const,
            stage: "score" as const,
          }))
        )
        .onConflictDoNothing()
        .returning({ id: schema.leads.id });
      inserted += rows.length;
    } catch (err) {
      recordError(ctx, "insert leads", err);
    }
  }

  ctx.counters.newLeads += inserted;
  return inserted;
}
