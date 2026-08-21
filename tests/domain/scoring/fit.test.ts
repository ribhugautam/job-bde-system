import { describe, it, expect } from "vitest";
import { scoreJob as scoreJobWithProfile, fitAdjustment } from "@/lib/domain/scoring/score";
import {
  defaultProfile,
  type ScoringProfile,
} from "@/lib/domain/scoring/profile";
import { yearsOfExperience } from "@/lib/domain/scoring/resume-profile";
import type { RawJob } from "@/lib/domain/types";

function makeJob(overrides: Partial<RawJob> = {}): RawJob {
  return {
    source: "test",
    sourceId: "job-1",
    title: "Full Stack Engineer",
    company: "Acme",
    url: "https://example.invalid/job-1",
    description: "React, TypeScript and Node.js.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Scoring is now per-profile: scoreJob(job, profile). Experience rules depend
// on the profile's careerStart, and the DEFAULT profile deliberately has none
// (skipping experience adjustments rather than guessing at somebody's
// seniority). These suites predate that and assert experience behaviour, so
// they run against an explicit profile with a known career start -- the same
// December 2023 date the hardcoded resume used, which keeps every expectation
// below meaning exactly what it did before.
// ---------------------------------------------------------------------------
const TEST_PROFILE: ScoringProfile = {
  ...defaultProfile(),
  careerStart: new Date("2023-12-01T00:00:00Z"),
};

const scoreJob = (job: RawJob, profile: ScoringProfile = TEST_PROFILE) =>
  scoreJobWithProfile(job, profile);

describe("fitAdjustment", () => {
  const YEARS = 3;

  it("penalises a geographically restricted role", () => {
    const { delta, reasons } = fitAdjustment(
      makeJob({ geoEligibility: "restricted", geoRegions: ["us"] }),
      YEARS
    );
    expect(delta).toBe(-25);
    expect(reasons.join(" ")).toMatch(/not open to your location/i);
  });

  it("rewards a worldwide role", () => {
    expect(fitAdjustment(makeJob({ geoEligibility: "worldwide" }), YEARS).delta).toBe(10);
  });

  it("gives unknown eligibility neither bonus nor penalty", () => {
    expect(fitAdjustment(makeJob({ geoEligibility: "unknown" }), YEARS).delta).toBe(0);
  });

  it("penalises an experience floor well above yours", () => {
    expect(fitAdjustment(makeJob({ minYears: 8 }), YEARS).delta).toBe(-20);
  });

  it("tolerates a floor within two years of yours", () => {
    expect(fitAdjustment(makeJob({ minYears: 5 }), YEARS).delta).toBe(0);
  });

  it("rewards a range that brackets your experience", () => {
    expect(fitAdjustment(makeJob({ minYears: 2, maxYears: 5 }), YEARS).delta).toBe(6);
  });

  it("rewards remote and penalises on-site, without hiding either", () => {
    expect(fitAdjustment(makeJob({ arrangement: "remote" }), YEARS).delta).toBe(5);
    expect(fitAdjustment(makeJob({ arrangement: "onsite" }), YEARS).delta).toBe(-8);
    expect(fitAdjustment(makeJob({ arrangement: "hybrid" }), YEARS).delta).toBe(-8);
    expect(fitAdjustment(makeJob({ arrangement: "unknown" }), YEARS).delta).toBe(0);
  });

  it("sums independent dimensions", () => {
    const { delta } = fitAdjustment(
      makeJob({ geoEligibility: "worldwide", arrangement: "remote", minYears: 2, maxYears: 5 }),
      YEARS
    );
    expect(delta).toBe(10 + 5 + 6);
  });

  it("nets a positive delta for India-eligible work, scaled by arrangement, and a negative one for US-only remote", () => {
    // These are the four reference points from the calibration: geo (+10 /
    // -25) and arrangement (+5 / -8) are independent axes that sum, and +10
    // was chosen specifically so it no longer exactly cancels the -8 on-site
    // penalty - an India-eligible on-site job must still net positive.
    const indiaRemote = fitAdjustment(
      makeJob({ geoEligibility: "eligible", arrangement: "remote" }),
      YEARS
    );
    const indiaOnsite = fitAdjustment(
      makeJob({ geoEligibility: "eligible", arrangement: "onsite" }),
      YEARS
    );
    const nothingKnown = fitAdjustment(makeJob(), YEARS);
    const usOnlyRemote = fitAdjustment(
      makeJob({ geoEligibility: "restricted", arrangement: "remote" }),
      YEARS
    );

    expect(indiaRemote.delta).toBe(15); // +10 + 5
    expect(indiaOnsite.delta).toBe(2); // +10 - 8
    expect(nothingKnown.delta).toBe(0);
    expect(usOnlyRemote.delta).toBe(-20); // -25 + 5
  });
});

describe("scoreJob with facts", () => {
  it("ranks an India-eligible remote role above an identical US-only one", () => {
    const base = { description: "React, TypeScript, Node.js, Next.js." };
    const eligible = scoreJob(
      makeJob({ ...base, geoEligibility: "worldwide", arrangement: "remote" })
    );
    const restricted = scoreJob(
      makeJob({ ...base, geoEligibility: "restricted", arrangement: "remote" })
    );
    expect(eligible.score).toBeGreaterThan(restricted.score);
  });

  it("ranks an India-eligible on-site job strictly between unknown-everything and an identical India-eligible remote job", () => {
    // This ordering is the property that GEO_ELIGIBLE_BONUS = 8 silently
    // broke: at +8 it exactly cancelled the -8 on-site penalty, so
    // India-eligible-on-site and unknown-everything scored identically and
    // arrangement stopped mattering for exactly the postings the operator
    // cares most about. Asserted directly here, not just via the individual
    // constants above.
    const base = { description: "React, TypeScript, Node.js, Next.js." };
    const indiaOnsite = scoreJob(
      makeJob({ ...base, geoEligibility: "eligible", arrangement: "onsite" })
    );
    const unknownEverything = scoreJob(makeJob(base));
    const indiaRemote = scoreJob(
      makeJob({ ...base, geoEligibility: "eligible", arrangement: "remote" })
    );

    expect(indiaOnsite.score).toBeGreaterThan(unknownEverything.score);
    expect(indiaOnsite.score).toBeLessThan(indiaRemote.score);
  });

  it("keeps a strong-skill posting above zero even when both geo and arrangement penalties fire", () => {
    // geoEligibility: "restricted" + arrangement: "onsite" nets -25 + -8 =
    // -33, a genuinely negative delta. (The case this test used to cover -
    // "eligible" + "hybrid" - summed to exactly +10 - 8 = +2 under the
    // corrected constants, and to exactly 0 under the old ones; either way it
    // never exercised negative-delta protection, despite the test's old
    // name claiming it did.) No single fit adjustment is fatal, so strong
    // skill evidence should still survive both of these firing at once.
    const result = scoreJob(
      makeJob({
        description: "React, TypeScript, Node.js, Next.js, agentic AI, LLM, RAG.",
        geoEligibility: "restricted",
        arrangement: "onsite",
      })
    );
    expect(result.score).toBeGreaterThan(0);
  });

  it("can reach exactly 0 when three penalties stack on modest skill evidence", () => {
    // restricted (-25) + on-site (-8) + over-experienced (-20) = -53. Combined
    // with a posting whose skill evidence alone normalizes to only 35, that
    // drives the final score to the floor. This is not a bug to guard
    // against - a job that is location-ineligible, on-site, AND wants far
    // more experience than the candidate has genuinely is a poor match - so
    // this test pins the real behaviour instead of asserting a floor that
    // isn't there. It only happens when all three signals are bad at once
    // *and* skill evidence is weak (contrast with the strong-skill case
    // above, which survives the same geo+arrangement penalties intact).
    const result = scoreJob(
      makeJob({
        title: "Engineer",
        description: "React, TypeScript, Node.js, Next.js.",
        geoEligibility: "restricted",
        arrangement: "onsite",
        minYears: 50,
      })
    );
    expect(result.score).toBe(0);
  });

  it("still returns 0 for a vetoed role regardless of perfect facts", () => {
    const result = scoreJob(
      makeJob({
        title: "Technical Recruiter",
        description: "React, TypeScript, Node.js.",
        geoEligibility: "worldwide",
        arrangement: "remote",
      })
    );
    expect(result.score).toBe(0);
  });

  it("keeps the score inside 0-100", () => {
    const result = scoreJob(
      makeJob({
        description: "React TypeScript Node.js Next.js Flutter LLM RAG MCP agentic AI",
        geoEligibility: "worldwide",
        arrangement: "remote",
        minYears: 2,
        maxYears: 5,
      })
    );
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});

describe("yearsOfExperience", () => {
  it("computes from the career start date", () => {
    expect(yearsOfExperience(new Date("2026-12-01T00:00:00Z"))).toBeCloseTo(3, 1);
  });
});
