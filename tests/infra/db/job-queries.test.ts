import { describe, it, expect, beforeEach } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import * as schema from "@/lib/infra/db/schema";
import { fetchFilteredJobs, fetchJobSources } from "@/lib/infra/db/job-queries";
import { DEFAULT_JOB_FILTERS } from "@/lib/domain/jobs/filters";

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

async function seed(rows: Array<Partial<typeof schema.jobs.$inferInsert>>) {
  await db.insert(schema.jobs).values(
    rows.map((r, i) => ({
      source: "test",
      sourceId: `job-${i}`,
      title: `Job ${i}`,
      company: "Acme",
      url: `https://example.invalid/${i}`,
      ...r,
    }))
  );
}

beforeEach(async () => {
  const client = createClient({ url: ":memory:" });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "lib/infra/db/migrations" });
});

describe("fetchFilteredJobs", () => {
  it("returns everything when no filter is set", async () => {
    await seed([{}, {}, {}]);
    const { rows, total } = await fetchFilteredJobs(db, DEFAULT_JOB_FILTERS, 50);
    expect(rows).toHaveLength(3);
    expect(total).toBe(3);
  });

  it("hides dismissed jobs by default", async () => {
    await seed([{ status: "found" }, { status: "ignored" }]);
    const { rows, total } = await fetchFilteredJobs(db, DEFAULT_JOB_FILTERS, 50);
    expect(rows).toHaveLength(1);
    expect(total).toBe(1);
  });

  it("includes dismissed jobs when asked", async () => {
    await seed([{ status: "found" }, { status: "ignored" }]);
    const { rows } = await fetchFilteredJobs(
      db,
      { ...DEFAULT_JOB_FILTERS, showDismissed: true },
      50
    );
    expect(rows).toHaveLength(2);
  });

  it("filters by eligibility", async () => {
    await seed([
      { geoEligibility: "eligible" },
      { geoEligibility: "restricted" },
      { geoEligibility: "worldwide" },
    ]);
    const { rows } = await fetchFilteredJobs(
      db,
      { ...DEFAULT_JOB_FILTERS, eligibility: ["eligible", "worldwide"] },
      50
    );
    expect(rows.map((r) => r.geoEligibility).sort()).toEqual(["eligible", "worldwide"]);
  });

  it("filters by arrangement", async () => {
    await seed([{ arrangement: "remote" }, { arrangement: "onsite" }]);
    const { rows } = await fetchFilteredJobs(
      db,
      { ...DEFAULT_JOB_FILTERS, arrangement: ["onsite"] },
      50
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].arrangement).toBe("onsite");
  });

  it("applies minScore as a floor, inclusive", async () => {
    await seed([{ score: 39 }, { score: 40 }, { score: 90 }]);
    const { rows } = await fetchFilteredJobs(db, { ...DEFAULT_JOB_FILTERS, minScore: 40 }, 50);
    expect(rows.map((r) => r.score).sort((a, b) => a! - b!)).toEqual([40, 90]);
  });

  it("filters by easy apply only when the flag is set", async () => {
    await seed([{ easyApply: true }, { easyApply: false }, {}]);
    expect(
      (await fetchFilteredJobs(db, { ...DEFAULT_JOB_FILTERS, easyApplyOnly: true }, 50)).rows
    ).toHaveLength(1);
    expect((await fetchFilteredJobs(db, DEFAULT_JOB_FILTERS, 50)).rows).toHaveLength(3);
  });

  it("matches the query against title and company, case-insensitively", async () => {
    await seed([
      { title: "React Engineer", company: "Acme" },
      { title: "Backend Engineer", company: "Reactive Labs" },
      { title: "Designer", company: "Other" },
    ]);
    const { rows } = await fetchFilteredJobs(db, { ...DEFAULT_JOB_FILTERS, query: "react" }, 50);
    expect(rows).toHaveLength(2);
  });

  it("combines filters with AND", async () => {
    await seed([
      { geoEligibility: "eligible", arrangement: "remote", score: 90 },
      { geoEligibility: "eligible", arrangement: "onsite", score: 90 },
      { geoEligibility: "restricted", arrangement: "remote", score: 90 },
    ]);
    const { rows } = await fetchFilteredJobs(
      db,
      { ...DEFAULT_JOB_FILTERS, eligibility: ["eligible"], arrangement: ["remote"] },
      50
    );
    expect(rows).toHaveLength(1);
  });

  it("sorts by score descending by default", async () => {
    await seed([{ score: 10 }, { score: 90 }, { score: 50 }]);
    const { rows } = await fetchFilteredJobs(db, DEFAULT_JOB_FILTERS, 50);
    expect(rows.map((r) => r.score)).toEqual([90, 50, 10]);
  });

  it("sorts by newest when asked", async () => {
    await seed([
      { title: "old", postedAt: new Date("2020-01-01") },
      { title: "new", postedAt: new Date("2026-01-01") },
    ]);
    const { rows } = await fetchFilteredJobs(db, { ...DEFAULT_JOB_FILTERS, sort: "newest" }, 50);
    expect(rows[0].title).toBe("new");
  });

  // total is the count BEFORE the limit — it drives the "59 of 695" readout,
  // which would be a lie if it counted only the page.
  it("reports the total matching count, not the page size", async () => {
    await seed(Array.from({ length: 10 }, () => ({})));
    const { rows, total } = await fetchFilteredJobs(db, DEFAULT_JOB_FILTERS, 3);
    expect(rows).toHaveLength(3);
    expect(total).toBe(10);
  });
});

describe("fetchJobSources", () => {
  it("lists each source once, commonest first", async () => {
    await seed([
      { source: "linkedin_alert" },
      { source: "ycombinator" },
      { source: "linkedin_alert" },
      { source: "linkedin_alert" },
      { source: "ycombinator" },
      { source: "remotive" },
    ]);
    expect(await fetchJobSources(db)).toEqual([
      "linkedin_alert",
      "ycombinator",
      "remotive",
    ]);
  });
});
