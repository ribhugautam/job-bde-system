import { describe, it, expect, beforeEach } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import * as schema from "@/lib/infra/db/schema";
import { fetchRankedJobs } from "@/lib/infra/db/job-queries";
import { DEFAULT_JOB_VIEW } from "@/lib/domain/jobs/filters";
import { defaultProfile, type ScoringProfile } from "@/lib/domain/scoring/profile";

// Runs against a REAL in-memory SQLite with the real migrations applied, so
// the bucket conditions are exercised as SQL rather than as a mock's opinion
// of SQL. The LEFT JOIN in particular cannot be tested any other way.

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

const NOW = new Date("2026-08-21T12:00:00Z");
const STALE_DAYS = 30;
const ME = 1;
const COLLEAGUE = 2;

const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

async function seed(rows: Array<Partial<typeof schema.jobs.$inferInsert>>) {
  await db.insert(schema.jobs).values(
    rows.map((r, i) => ({
      source: "test",
      sourceId: `job-${i}`,
      title: `Job ${i}`,
      company: "Acme",
      url: `https://example.invalid/${i}`,
      // Fresh unless a test says otherwise, so age never surprises a test that
      // is about something else.
      fetchedAt: daysAgo(1),
      ...r,
    }))
  );
}

async function setState(userId: number, jobId: number, status: string) {
  await db.insert(schema.jobUserState).values({ userId, jobId, status });
}

function fetch(overrides: {
  view?: Partial<typeof DEFAULT_JOB_VIEW>;
  profile?: ScoringProfile;
  userId?: number;
  lastSeenAt?: Date | null;
  pageSize?: number;
} = {}) {
  return fetchRankedJobs({
    db,
    userId: overrides.userId ?? ME,
    view: { ...DEFAULT_JOB_VIEW, ...overrides.view },
    profile: overrides.profile ?? defaultProfile(),
    staleDays: STALE_DAYS,
    pageSize: overrides.pageSize ?? 100,
    lastSeenAt: overrides.lastSeenAt ?? null,
    now: NOW,
  });
}

beforeEach(async () => {
  const client = createClient({ url: ":memory:" });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "lib/infra/db/migrations" });
});

describe("inbox", () => {
  it("shows untriaged jobs with no state row at all", async () => {
    // The case that matters most: a brand-new colleague has zero rows in
    // job_user_state, and must still see a full inbox. An INNER join here
    // would show them nothing.
    await seed([{}, {}, {}]);
    const { rows, total } = await fetch();
    expect(rows).toHaveLength(3);
    expect(total).toBe(3);
  });

  it("excludes jobs older than the stale window", async () => {
    await seed([{ fetchedAt: daysAgo(5) }, { fetchedAt: daysAgo(45) }]);
    const { rows } = await fetch();
    expect(rows).toHaveLength(1);
  });

  it("prefers postedAt over fetchedAt when judging age", async () => {
    // A job first fetched today because a source was switched on may have been
    // advertised for months. Fetch time alone would call it brand new.
    await seed([{ postedAt: daysAgo(60), fetchedAt: daysAgo(1) }]);
    expect((await fetch()).rows).toHaveLength(0);
  });

  it("treats a job with no dates at all as fresh rather than hiding it", async () => {
    await seed([{ postedAt: null, fetchedAt: null }]);
    expect((await fetch()).rows).toHaveLength(1);
  });

  it("excludes jobs I dismissed", async () => {
    await seed([{}, {}]);
    await setState(ME, 1, "ignored");
    const { rows } = await fetch();
    expect(rows.map((r) => r.job.id)).toEqual([2]);
  });

  it("STILL shows jobs a colleague dismissed", async () => {
    // The whole point of a shared pool with private state. If this ever fails,
    // one person's triage is silently deciding what everybody else sees.
    await seed([{}, {}]);
    await setState(COLLEAGUE, 1, "ignored");
    await setState(COLLEAGUE, 2, "sent");
    const { rows } = await fetch();
    expect(rows.map((r) => r.job.id).sort()).toEqual([1, 2]);
  });

  it("excludes jobs I have picked up", async () => {
    await seed([{}, {}]);
    await setState(ME, 1, "matched");
    expect((await fetch()).rows.map((r) => r.job.id)).toEqual([2]);
  });

  it("treats an explicit `found` status as still untriaged", async () => {
    await seed([{}]);
    await setState(ME, 1, "found");
    expect((await fetch()).rows).toHaveLength(1);
  });
});

describe("working", () => {
  it("holds only the jobs I have picked up", async () => {
    await seed([{}, {}, {}]);
    await setState(ME, 1, "matched");
    await setState(ME, 2, "sent");
    await setState(COLLEAGUE, 3, "matched");
    const { rows } = await fetch({ view: { bucket: "working" } });
    expect(rows.map((r) => r.job.id).sort()).toEqual([1, 2]);
  });

  it("keeps an old job I am working, rather than expiring it", async () => {
    // Age only decides for UNTRIAGED jobs. A job somebody applied to two
    // months ago belongs in Working, not swept into Archive for being old.
    await seed([{ fetchedAt: daysAgo(90) }]);
    await setState(ME, 1, "sent");
    expect((await fetch({ view: { bucket: "working" } })).rows).toHaveLength(1);
  });
});

describe("archive", () => {
  it("holds jobs I dismissed and jobs that timed out, and says which is which", async () => {
    await seed([{}, { fetchedAt: daysAgo(45) }]);
    await setState(ME, 1, "ignored");

    const { rows } = await fetch({ view: { bucket: "archive" } });
    const byId = new Map(rows.map((r) => [r.job.id, r]));
    expect(byId.get(1)?.archivedBecause).toBe("dismissed");
    expect(byId.get(2)?.archivedBecause).toBe("expired");
  });
});

describe("ranking", () => {
  const reactDev: ScoringProfile = {
    ...defaultProfile(),
    skills: [{ name: "react", weight: 3, aliases: ["react.js"] }],
  };
  const goDev: ScoringProfile = {
    ...defaultProfile(),
    skills: [{ name: "go", weight: 3, aliases: ["golang"] }],
  };

  it("orders by the VIEWER's score, so two people see different orders", async () => {
    await seed([
      { title: "React Engineer", description: "React all day." },
      { title: "Go Engineer", description: "Go services." },
    ]);

    const forReact = await fetch({ profile: reactDev });
    const forGo = await fetch({ profile: goDev });

    expect(forReact.rows[0].job.title).toBe("React Engineer");
    expect(forGo.rows[0].job.title).toBe("Go Engineer");
  });

  it("breaks score ties on id so the list does not reshuffle between renders", async () => {
    await seed([{ description: "nothing" }, { description: "nothing" }]);
    const first = await fetch();
    const second = await fetch();
    expect(first.rows.map((r) => r.job.id)).toEqual(second.rows.map((r) => r.job.id));
  });
});

describe("search", () => {
  it("matches title or company", async () => {
    await seed([
      { title: "Frontend Engineer", company: "Stripe" },
      { title: "Backend Engineer", company: "Acme" },
    ]);
    expect((await fetch({ view: { query: "stripe" } })).rows).toHaveLength(1);
    expect((await fetch({ view: { query: "backend" } })).rows).toHaveLength(1);
  });

  it("treats wildcards as literal text so a % narrows rather than widens", async () => {
    await seed([{ title: "Engineer" }]);
    expect((await fetch({ view: { query: "%" } })).rows).toHaveLength(0);
  });
});

describe("pagination", () => {
  it("splits the list and reports the full total", async () => {
    await seed(Array.from({ length: 25 }, () => ({})));
    const page1 = await fetch({ pageSize: 10 });
    const page3 = await fetch({ pageSize: 10, view: { page: 3 } });

    expect(page1.rows).toHaveLength(10);
    expect(page1.total).toBe(25);
    expect(page3.rows).toHaveLength(5);
  });

  it("returns an empty page rather than failing past the end", async () => {
    await seed([{}]);
    expect((await fetch({ view: { page: 99 } })).rows).toEqual([]);
  });
});

describe("counts", () => {
  it("counts every bucket for this user in one pass", async () => {
    await seed([{}, {}, {}, { fetchedAt: daysAgo(60) }]);
    await setState(ME, 1, "matched");
    await setState(ME, 2, "ignored");

    const { counts } = await fetch();
    expect(counts).toEqual({ inbox: 1, working: 1, archive: 2 });
  });

  it("is unaffected by a colleague's triage", async () => {
    await seed([{}, {}]);
    await setState(COLLEAGUE, 1, "ignored");
    await setState(COLLEAGUE, 2, "sent");
    expect((await fetch()).counts).toEqual({ inbox: 2, working: 0, archive: 0 });
  });
});

describe("the new-since-you-looked marker", () => {
  it("marks only jobs fetched after the last visit", async () => {
    await seed([{ fetchedAt: daysAgo(10) }, { fetchedAt: daysAgo(1) }]);
    const { rows } = await fetch({ lastSeenAt: daysAgo(5) });
    const byId = new Map(rows.map((r) => [r.job.id, r.isNew]));
    expect(byId.get(1)).toBe(false);
    expect(byId.get(2)).toBe(true);
  });

  it("marks nothing on a first ever visit", async () => {
    // Flagging all 700 rows as new says nothing at all.
    await seed([{}, {}]);
    const { rows } = await fetch({ lastSeenAt: null });
    expect(rows.every((r) => !r.isNew)).toBe(true);
  });
});
