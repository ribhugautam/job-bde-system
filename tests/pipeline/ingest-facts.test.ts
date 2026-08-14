import { describe, it, expect } from "vitest";
import { deriveJobFacts } from "@/lib/domain/facts";
import { factsToRow, mergeExperienceFacts } from "@/lib/pipeline/stages/ingest";
import type { RawJob } from "@/lib/domain/types";

// ingest.ts builds its insert payload from deriveJobFacts() + factsToRow(). This
// test pins the exact translation, which is where the original bug lived:
// `remote ?? true` silently overwrote a deliberate tri-state and made every one
// of 623 rows claim to be remote. It imports factsToRow from the shipped module
// rather than duplicating its logic, so a regression in ingest.ts itself fails
// this test.
function insertValues(raw: RawJob) {
  const facts = deriveJobFacts(raw);
  return factsToRow(facts);
}

describe("ingest fact translation", () => {
  it("stores an on-site job as not remote", () => {
    const row = insertValues({
      source: "linkedin_alert",
      sourceId: "1",
      title: "Engineer",
      company: "Acme",
      url: "https://example.invalid/1",
      location: "Bengaluru (On-site)",
    });
    expect(row.arrangement).toBe("onsite");
    expect(row.remote).toBe(false);
  });

  it("stores an unknown arrangement as null, never true", () => {
    const row = insertValues({
      source: "adzuna",
      sourceId: "2",
      title: "Engineer",
      company: "Acme",
      url: "https://example.invalid/2",
      location: "Bedford, ",
    });
    expect(row.arrangement).toBe("unknown");
    expect(row.remote).toBeNull();
  });

  it("still stores a genuine remote job as remote", () => {
    const row = insertValues({
      source: "himalayas",
      sourceId: "3",
      title: "Engineer",
      company: "Acme",
      url: "https://example.invalid/3",
      location: "Anywhere in the World",
      remote: true,
    });
    expect(row.arrangement).toBe("remote");
    expect(row.remote).toBe(true);
  });

  it("stores a hybrid job as not remote", () => {
    const row = insertValues({
      source: "linkedin_alert",
      sourceId: "4",
      title: "Engineer",
      company: "Acme",
      url: "https://example.invalid/4",
      location: "Bengaluru (Hybrid)",
    });
    expect(row.arrangement).toBe("hybrid");
    expect(row.remote).toBe(false);
  });
});

// The cross-source merge branch (db.update in ingestJobs) re-derives experience
// facts through mergeExperienceFacts when a merge gains a richer description —
// see the doc comment on mergeExperienceFacts in ingest.ts for why experience is
// the only fact re-derived there. The merge branch itself needs a live
// database and has no direct unit test, so this pins the decision function it
// calls: imported straight from the shipped module, not a copy of it.
describe("mergeExperienceFacts", () => {
  it("updates minYears when the gained description states a requirement", () => {
    const facts = mergeExperienceFacts(
      "Engineer",
      "We need someone with 8+ years of backend experience.",
      true
    );
    expect(facts?.minYears).toBe(8);
  });

  it("leaves the experience fields empty, not invented, when the gained description states no requirement", () => {
    const facts = mergeExperienceFacts(
      "Engineer",
      "Join our friendly team building great products.",
      true
    );
    expect(facts).toEqual({});
    expect(facts?.minYears).toBeUndefined();
    expect(facts?.maxYears).toBeUndefined();
    expect(facts?.experienceText).toBeUndefined();
  });

  it("does not change the experience fields at all when the merge gained no description", () => {
    const facts = mergeExperienceFacts(
      "Engineer",
      "We need someone with 8+ years of backend experience.",
      false
    );
    expect(facts).toBeUndefined();
  });
});
