import { describe, it, expect } from "vitest";
import { deriveExperience } from "@/lib/domain/facts/experience";

describe("deriveExperience", () => {
  it("reads a plus-form floor", () => {
    expect(deriveExperience("We want 8+ years of experience")).toMatchObject({
      minYears: 8,
      maxYears: undefined,
    });
  });

  it("reads a hyphenated range", () => {
    expect(deriveExperience("3-5 years building web apps")).toMatchObject({
      minYears: 3,
      maxYears: 5,
    });
  });

  // Taken verbatim from a real LinkedIn card in production.
  it("reads a 'N to M Years' range", () => {
    expect(
      deriveExperience("Gen AI / LLM Backend Developer - 2 to 5 Years")
    ).toMatchObject({ minYears: 2, maxYears: 5 });
  });

  it("reads an 'at least' floor", () => {
    expect(deriveExperience("at least 6 years in React")).toMatchObject({
      minYears: 6,
    });
  });

  it("returns nothing when no requirement is stated", () => {
    expect(deriveExperience("A great place to work")).toEqual({});
  });

  // Preserves the deliberate exclusion documented in score.ts: a bare "N years"
  // is a company blurb, not a seniority bar.
  it("ignores a bare 'N years' company blurb", () => {
    expect(deriveExperience("Serving clients for over 10 years")).toEqual({});
  });

  it("does not read 110+ years as 10+ years", () => {
    expect(deriveExperience("110+ years of heritage")).toEqual({});
  });

  // Parity with the old requiresTooManyYears(): a posting stating several
  // floors is asking for the highest of them.
  it("takes the highest stated floor when several appear", () => {
    const facts = deriveExperience("3+ years overall, 9+ years with Java");
    expect(facts.minYears).toBe(9);
  });

  it("pairs maxYears with the winning floor", () => {
    const facts = deriveExperience("1-2 years support, or 6-9 years engineering");
    expect(facts).toMatchObject({ minYears: 6, maxYears: 9 });
  });

  it("reports the phrase it matched", () => {
    expect(deriveExperience("we need 8+ years").experienceText).toContain("8+");
  });

  it("is case insensitive and handles yrs", () => {
    expect(deriveExperience("MINIMUM OF 7 YRS")).toMatchObject({ minYears: 7 });
  });
});
