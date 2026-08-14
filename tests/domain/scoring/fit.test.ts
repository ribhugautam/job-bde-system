import { describe, it, expect } from "vitest";
import { scoreJob, fitAdjustment } from "@/lib/domain/scoring/score";
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
    expect(fitAdjustment(makeJob({ geoEligibility: "worldwide" }), YEARS).delta).toBe(8);
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
    expect(delta).toBe(8 + 5 + 6);
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

  it("never drops a hybrid India role to zero — it stays filterable", () => {
    const result = scoreJob(
      makeJob({
        description: "React, TypeScript, Node.js, Next.js, agentic AI, LLM, RAG.",
        geoEligibility: "eligible",
        arrangement: "hybrid",
      })
    );
    expect(result.score).toBeGreaterThan(0);
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
