import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq } from "drizzle-orm";
import { getEnv, resetEnvCache } from "@/lib/config/env";
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
    env: getEnv(),
    deadline: createDeadline(60_000),
    counters: emptyCounters(),
    errors: [],
    notices: [],
  };
  return { ctx, db };
}

async function insertJob(
  db: StageContext["db"],
  overrides: { sourceId: string; url: string; company: string }
) {
  await db.insert(schema.jobs).values({
    source: "linkedin_alert",
    sourceId: overrides.sourceId,
    title: "Full Stack Engineer",
    company: overrides.company,
    url: overrides.url,
    stage: "enrich",
    status: "found",
    remote: null,
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
