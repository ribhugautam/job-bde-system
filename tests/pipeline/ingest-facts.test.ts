import { describe, it, expect } from "vitest";
import { deriveJobFacts } from "@/lib/domain/facts";
import { factsToRow } from "@/lib/pipeline/stages/ingest";
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
