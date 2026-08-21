import { describe, expect, it } from "vitest";
import {
  archiveReason,
  deriveBucket,
  effectiveDate,
  isNewSince,
  isStale,
  parseBucket,
} from "@/lib/domain/jobs/buckets";
import {
  DEFAULT_JOB_VIEW,
  parseJobView,
  serializeJobView,
  withView,
} from "@/lib/domain/jobs/filters";

const NOW = new Date("2026-08-21T12:00:00Z");
const STALE_DAYS = 30;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

const age = (postedAt: Date | null, fetchedAt: Date | null = null) => ({
  postedAt,
  fetchedAt,
});

describe("effectiveDate", () => {
  it("prefers postedAt over fetchedAt", () => {
    // A job first fetched today because a source was switched on may have been
    // advertised for months; fetch time alone would call it brand new.
    expect(effectiveDate(age(daysAgo(60), daysAgo(1)))).toEqual(daysAgo(60));
  });

  it("falls back to fetchedAt, then to null", () => {
    expect(effectiveDate(age(null, daysAgo(3)))).toEqual(daysAgo(3));
    expect(effectiveDate(age(null, null))).toBeNull();
  });
});

describe("isStale", () => {
  it("pins the exact boundary", () => {
    // Inclusive at the boundary: a job exactly staleDays old is stale.
    expect(isStale(age(daysAgo(30)), NOW, STALE_DAYS)).toBe(true);
    expect(isStale(age(daysAgo(29.99)), NOW, STALE_DAYS)).toBe(false);
    expect(isStale(age(daysAgo(30.01)), NOW, STALE_DAYS)).toBe(true);
  });

  it("treats an unknown age as fresh rather than hiding the job", () => {
    expect(isStale(age(null, null), NOW, STALE_DAYS)).toBe(false);
  });

  it("responds immediately to a changed window, in both directions", () => {
    // The point of deriving rather than storing: JOB_STALE_DAYS can move and
    // every bucket reflows with no migration and nothing to undo.
    const job = age(daysAgo(40));
    expect(isStale(job, NOW, 30)).toBe(true);
    expect(isStale(job, NOW, 60)).toBe(false);
  });
});

describe("deriveBucket", () => {
  const derive = (state: { status: string } | null, ageIn = age(daysAgo(1))) =>
    deriveBucket({ state, age: ageIn, now: NOW, staleDays: STALE_DAYS });

  it("puts an untouched, fresh job in the inbox", () => {
    expect(derive(null)).toBe("inbox");
  });

  it("treats an explicit `found` status as still untriaged", () => {
    // `found` is where every job starts. Counting it as "working" would put the
    // entire backlog in that bucket and leave the inbox permanently empty.
    expect(derive({ status: "found" })).toBe("inbox");
  });

  it("archives an untouched job once it goes stale", () => {
    expect(derive(null, age(daysAgo(45)))).toBe("archive");
  });

  it.each(["matched", "ready_for_review", "applied", "sent", "responded", "interview", "offer"])(
    "puts status %s in working",
    (status) => {
      expect(derive({ status })).toBe("working");
    }
  );

  it.each(["ignored", "rejected", "closed"])(
    "puts status %s in archive",
    (status) => {
      expect(derive({ status })).toBe("archive");
    }
  );

  it("lets an explicit status outrank age", () => {
    // A job somebody applied to two months ago belongs in Working, not swept
    // into Archive for being old. Only untriaged jobs can expire.
    expect(derive({ status: "sent" }, age(daysAgo(90)))).toBe("working");
  });

  it("puts every job in exactly one bucket", () => {
    // The guarantee the SQL in job-queries.ts has to match: no job may fall
    // through every bucket and become invisible.
    const states = [null, { status: "found" }, { status: "sent" }, { status: "ignored" }];
    const ages = [age(daysAgo(1)), age(daysAgo(90)), age(null, null)];
    for (const state of states) {
      for (const a of ages) {
        const bucket = deriveBucket({ state, age: a, now: NOW, staleDays: STALE_DAYS });
        expect(["inbox", "working", "archive"]).toContain(bucket);
      }
    }
  });

  it("ignores an unrecognised status rather than inventing a bucket", () => {
    // An unknown status is not a reason to hide a job.
    expect(derive({ status: "nonsense" })).toBe("inbox");
  });
});

describe("archiveReason", () => {
  it("distinguishes giving up from timing out", () => {
    const base = { now: NOW, staleDays: STALE_DAYS };
    expect(
      archiveReason({ ...base, state: { status: "ignored" }, age: age(daysAgo(1)) })
    ).toBe("dismissed");
    expect(archiveReason({ ...base, state: null, age: age(daysAgo(45)) })).toBe("expired");
    expect(archiveReason({ ...base, state: null, age: age(daysAgo(1)) })).toBeNull();
  });
});

describe("isNewSince", () => {
  it("marks only what arrived after the last visit", () => {
    expect(isNewSince(age(null, daysAgo(1)), daysAgo(5))).toBe(true);
    expect(isNewSince(age(null, daysAgo(10)), daysAgo(5))).toBe(false);
  });

  it("marks nothing on a first ever visit", () => {
    // Flagging all 700 rows as new says nothing at all.
    expect(isNewSince(age(null, daysAgo(1)), null)).toBe(false);
  });
});

describe("parseBucket", () => {
  it("falls back to the inbox for anything unrecognised", () => {
    for (const raw of [undefined, null, "", "INBOX", "trash", "working "]) {
      expect(parseBucket(raw), String(raw)).toBe("inbox");
    }
    expect(parseBucket("archive")).toBe("archive");
  });
});

describe("parseJobView", () => {
  const parse = (qs: string) => parseJobView(new URLSearchParams(qs));

  it("reads bucket, query and page", () => {
    expect(parse("bucket=archive&q=stripe&page=3")).toEqual({
      bucket: "archive",
      query: "stripe",
      page: 3,
    });
  });

  it("is total: a hand-edited URL renders a page rather than throwing", () => {
    expect(parse("bucket=nonsense&page=-4")).toEqual(DEFAULT_JOB_VIEW);
    expect(parse("page=abc").page).toBe(1);
    expect(parse("page=2.7").page).toBe(2);
    expect(parse("q=%20%20").query).toBeUndefined();
  });
});

describe("serializeJobView", () => {
  it("omits defaults so the default view has an empty query string", () => {
    expect(serializeJobView(DEFAULT_JOB_VIEW).toString()).toBe("");
  });

  it("round-trips a non-default view", () => {
    const view = { bucket: "working" as const, query: "acme", page: 2 };
    expect(parseJobView(serializeJobView(view))).toEqual(view);
  });
});

describe("withView", () => {
  const onPage4 = { bucket: "archive" as const, query: undefined, page: 4 };

  it("resets to page 1 when the bucket changes", () => {
    // Otherwise page 4 of Archive becomes page 4 of an inbox with two pages --
    // an empty screen that reads as "you have no new jobs".
    expect(withView(onPage4, { bucket: "inbox" }).page).toBe(1);
  });

  it("resets to page 1 when the query changes", () => {
    expect(withView(onPage4, { query: "stripe" }).page).toBe(1);
  });

  it("keeps the page when only paging", () => {
    expect(withView(onPage4, { page: 5 }).page).toBe(5);
  });

  it("keeps the page when the bucket is set to what it already was", () => {
    expect(withView(onPage4, { bucket: "archive" }).page).toBe(4);
  });
});
