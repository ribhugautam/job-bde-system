import { describe, it, expect } from "vitest";
import { jobFactChips } from "@/components/jobs/factChips";

describe("jobFactChips", () => {
  it("marks an India-eligible job with the takeable tone", () => {
    const chips = jobFactChips({ geoEligibility: "eligible" });
    expect(chips).toContainEqual({ label: "eligible", tone: "ok" });
  });

  it("marks a restricted job with the danger tone", () => {
    expect(jobFactChips({ geoEligibility: "restricted" })).toContainEqual({
      label: "restricted",
      tone: "danger",
    });
  });

  it("marks worldwide with the info tone, not the takeable one", () => {
    // worldwide and eligible both score +10, but they say different things:
    // one states no restriction, the other states you specifically qualify.
    expect(jobFactChips({ geoEligibility: "worldwide" })).toContainEqual({
      label: "worldwide",
      tone: "info",
    });
  });

  it("marks office-presence arrangements amber", () => {
    expect(jobFactChips({ arrangement: "onsite" })).toContainEqual({ label: "on-site", tone: "warn" });
    expect(jobFactChips({ arrangement: "hybrid" })).toContainEqual({ label: "hybrid", tone: "warn" });
  });

  it("does not emit a chip for an unknown fact", () => {
    // "unknown" is the honest absence of evidence; a chip saying so is noise.
    expect(jobFactChips({ geoEligibility: "unknown", arrangement: "unknown" })).toEqual([]);
  });

  it("emits nothing at all for a job with no facts", () => {
    expect(jobFactChips({})).toEqual([]);
  });

  it("shows an experience floor when one is stated", () => {
    expect(jobFactChips({ minYears: 4 })).toContainEqual({ label: "4y+", tone: "neutral" });
  });

  it("shows easy apply only when true", () => {
    expect(jobFactChips({ easyApply: true })).toContainEqual({ label: "easy apply", tone: "neutral" });
    expect(jobFactChips({ easyApply: false })).toEqual([]);
  });

  it("orders chips eligibility, arrangement, experience, easy apply", () => {
    const chips = jobFactChips({
      geoEligibility: "eligible",
      arrangement: "remote",
      minYears: 3,
      easyApply: true,
    });
    expect(chips.map((c) => c.label)).toEqual(["eligible", "remote", "3y+", "easy apply"]);
  });
});
