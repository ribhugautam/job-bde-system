import { describe, it, expect } from "vitest";
import { deriveJobFacts, FACTS_VERSION } from "@/lib/domain/facts";

describe("deriveJobFacts", () => {
  it("combines all three axes", () => {
    expect(
      deriveJobFacts({
        title: "Senior Engineer",
        location: "Bengaluru (Hybrid)",
        description: "You have 4-7 years of experience.",
      })
    ).toMatchObject({
      arrangement: "hybrid",
      geoEligibility: "eligible",
      geoRegions: ["in"],
      minYears: 4,
      maxYears: 7,
    });
  });

  it("scans title and description together for experience", () => {
    expect(
      deriveJobFacts({ title: "Backend Developer - 2 to 5 Years", location: "India" })
    ).toMatchObject({ minYears: 2, maxYears: 5 });
  });

  it("returns unknowns rather than guesses for an empty job", () => {
    expect(deriveJobFacts({ title: "" })).toEqual({
      arrangement: "unknown",
      geoEligibility: "unknown",
      geoRegions: [],
      minYears: undefined,
      maxYears: undefined,
      experienceText: undefined,
      easyApply: undefined,
    });
  });

  it("does not overwrite facts the source already supplied", () => {
    // Y Combinator (Phase 2) supplies minExperience directly; a source that
    // knows a fact must win over re-deriving it from prose.
    const facts = deriveJobFacts({
      title: "Engineer",
      location: "Remote",
      minYears: 3,
      easyApply: true,
    });
    expect(facts.minYears).toBe(3);
    expect(facts.easyApply).toBe(true);
  });

  it("exposes a positive integer version", () => {
    expect(Number.isInteger(FACTS_VERSION)).toBe(true);
    expect(FACTS_VERSION).toBeGreaterThan(0);
  });

  it("preserves a source-supplied maxYears even without a matching minYears", () => {
    const facts = deriveJobFacts({ maxYears: 5 });
    expect(facts.maxYears).toBe(5);
    expect(facts.minYears).toBeUndefined();
  });

  it("preserves source-supplied geoRegions even without an explicit geoEligibility", () => {
    const facts = deriveJobFacts({ geoRegions: ["in"] });
    expect(facts.geoRegions).toEqual(["in"]);
  });
});
