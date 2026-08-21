import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq } from "drizzle-orm";
import { getEnv, resetEnvCache } from "@/lib/config/env";
import { defaultSettings } from "@/lib/config/settings";
import { createDeadline } from "@/lib/pipeline/deadline";
import { emptyCounters, type StageContext } from "@/lib/pipeline/context";
import { runEnrich } from "@/lib/pipeline/stages/enrich";
import * as schema from "@/lib/infra/db/schema";

// ---------------------------------------------------------------------------
// Covers the cache-hit branch of runEnrich, which tests/infra/linkedin/enrich
// .test.ts cannot reach: that file only exercises fetchJobDescription/
// parseJobPage in isolation, never the stage function that reads an already-
// cached linkedin_enrich_cache row and decides whether to write its company
// onto the job.
//
// Every job passes through 'enrich' exactly once (advance() unconditionally
// moves the row to 'score', and the stage machine is forward-only - see
// JOB_STAGES in lib/pipeline/state.ts). So a cache hit is a job's ONLY chance
// to pick up a company recovered from an earlier fetch of the same LinkedIn
// id, and that path must honor the same "only overwrite the Unknown
// placeholder" guard the live-fetch path already has.
//
// A real in-memory libSQL database is used (migrated with the project's own
// migrations) rather than a hand-rolled mock, so this exercises the exact
// drizzle queries runEnrich issues instead of a re-implementation of them.
// ---------------------------------------------------------------------------

async function buildCtx(): Promise<{ ctx: StageContext; db: StageContext["db"] }> {
  const client = createClient({ url: "file::memory:" });
  const db: StageContext["db"] = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "lib/infra/db/migrations" });

  resetEnvCache();
  const ctx: StageContext = {
    db,
    // Secrets from env, operational values from the settings defaults. Built
    // here rather than via getAppConfig() so the fixture stays synchronous and
    // touches no settings row.
    config: { ...getEnv(), ...defaultSettings(), dryRun: false, settingsConfigured: false },
    deadline: createDeadline(60_000),
    counters: emptyCounters(),
    errors: [],
    notices: [],
    // Enrich never sends, so a null sender is the honest fixture here.
    sender: null,
    ownerUserId: null,
  };
  return { ctx, db };
}

async function insertJob(
  db: StageContext["db"],
  overrides: {
    sourceId: string;
    url: string;
    company: string;
    title?: string;
    minYears?: number | null;
    maxYears?: number | null;
    experienceText?: string | null;
  }
) {
  await db.insert(schema.jobs).values({
    source: "linkedin_alert",
    sourceId: overrides.sourceId,
    title: overrides.title ?? "Full Stack Engineer",
    company: overrides.company,
    url: overrides.url,
    stage: "enrich",
    status: "found",
    remote: null,
    minYears: overrides.minYears ?? null,
    maxYears: overrides.maxYears ?? null,
    experienceText: overrides.experienceText ?? null,
  });
  const [row] = await db
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.sourceId, overrides.sourceId));
  return row;
}

afterEach(() => {
  resetEnvCache();
});

describe("runEnrich - cache-hit company recovery", () => {
  it("writes the cached company onto a job whose stored company is the Unknown placeholder", async () => {
    const { ctx, db } = await buildCtx();

    const job = await insertJob(db, {
      sourceId: "unknown-co",
      url: "https://www.linkedin.com/jobs/view/1111111",
      company: "Unknown",
    });

    await db.insert(schema.linkedinEnrichCache).values({
      jobId: "1111111",
      description: "Build things with React.",
      company: "Acme Corp",
      outcome: "ok",
      httpStatus: 200,
    });

    const result = await runEnrich(ctx);
    expect(result).toEqual({ processed: 1, hasMore: false });

    const [after] = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, job.id));
    expect(after.company).toBe("Acme Corp");
    expect(after.stage).toBe("score");
  });

  it("never overwrites a company a source already stated correctly, even on a cache hit", async () => {
    const { ctx, db } = await buildCtx();

    const job = await insertJob(db, {
      sourceId: "real-co",
      url: "https://www.linkedin.com/jobs/view/2222222",
      company: "Real Co",
    });

    await db.insert(schema.linkedinEnrichCache).values({
      jobId: "2222222",
      description: "Build things with React.",
      company: "Some Other Name",
      outcome: "ok",
      httpStatus: 200,
    });

    const result = await runEnrich(ctx);
    expect(result).toEqual({ processed: 1, hasMore: false });

    const [after] = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, job.id));
    expect(after.company).toBe("Real Co");
    expect(after.stage).toBe("score");
  });
});

// ---------------------------------------------------------------------------
// Regression coverage for the finding: enrich writes a description but never
// re-derived experience facts. A `linkedin_alert` job's minYears/maxYears/
// experienceText are derived from its TITLE alone at ingest (alert emails
// carry no description); once enrich recovers a real description, that is new
// evidence deriveExperience never saw. scoreJob trusts the stored fact rather
// than re-parsing text (tests/domain/scoring/score.test.ts:552,593), so a row
// whose experience fields are never refreshed here scores on stale evidence
// forever - exactly the regression pinned below.
// ---------------------------------------------------------------------------
describe("runEnrich - re-deriving experience facts from a newly written description", () => {
  it("writes minYears from a description that states an experience requirement", async () => {
    const { ctx, db } = await buildCtx();

    const job = await insertJob(db, {
      sourceId: "ten-years",
      url: "https://www.linkedin.com/jobs/view/3333333",
      company: "Acme Corp",
      title: "Staff Engineer",
    });
    // Title alone states no requirement - the exact starting state a
    // linkedin_alert row is ingested with.
    expect(job.minYears).toBeNull();

    await db.insert(schema.linkedinEnrichCache).values({
      jobId: "3333333",
      description:
        "We build great software. Minimum 10 years of experience required.",
      company: "Acme Corp",
      outcome: "ok",
      httpStatus: 200,
    });

    const result = await runEnrich(ctx);
    expect(result).toEqual({ processed: 1, hasMore: false });

    const [after] = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, job.id));
    expect(after.minYears).toBe(10);
    expect(after.maxYears).toBeNull();
    expect(after.experienceText).toBe("Minimum 10 years");
    expect(after.stage).toBe("score");
  });

  it("leaves experience fields null when the newly written description states no requirement", async () => {
    const { ctx, db } = await buildCtx();

    const job = await insertJob(db, {
      sourceId: "no-years",
      url: "https://www.linkedin.com/jobs/view/4444444",
      company: "Acme Corp",
      title: "Full Stack Engineer",
    });

    await db.insert(schema.linkedinEnrichCache).values({
      jobId: "4444444",
      description: "Join our team and build great products with React and Node.js.",
      company: "Acme Corp",
      outcome: "ok",
      httpStatus: 200,
    });

    const result = await runEnrich(ctx);
    expect(result).toEqual({ processed: 1, hasMore: false });

    const [after] = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, job.id));
    // No requirement stated anywhere in title+description: nothing must be
    // invented, and the fields must be actual NULL, not left undefined.
    expect(after.minYears).toBeNull();
    expect(after.maxYears).toBeNull();
    expect(after.experienceText).toBeNull();
    expect(after.description).toContain("React and Node.js");
    expect(after.stage).toBe("score");
  });

  it("does not touch experience fields when the enrich outcome carries no description", async () => {
    const { ctx, db } = await buildCtx();

    const job = await insertJob(db, {
      sourceId: "blocked",
      url: "https://www.linkedin.com/jobs/view/5555555",
      company: "Acme Corp",
      title: "Staff Engineer",
      minYears: 12,
      experienceText: "12+ years",
    });

    await db.insert(schema.linkedinEnrichCache).values({
      jobId: "5555555",
      outcome: "blocked",
      httpStatus: 429,
    });

    const result = await runEnrich(ctx);
    expect(result).toEqual({ processed: 1, hasMore: false });

    const [after] = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, job.id));
    // No description was written on this pass, so no new evidence exists -
    // the title-derived fields set at insert time must survive untouched.
    expect(after.minYears).toBe(12);
    expect(after.maxYears).toBeNull();
    expect(after.experienceText).toBe("12+ years");
    expect(after.description).toBeNull();
    expect(after.stage).toBe("score");
  });
});
