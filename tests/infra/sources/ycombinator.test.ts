import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseYCPayload, visaToGeo } from "@/lib/infra/sources/ycombinator";

const html = readFileSync("tests/fixtures/ycombinator-eng.html", "utf8");

describe("visaToGeo", () => {
  it("treats a US-only visa requirement as restricted", () => {
    expect(visaToGeo("US citizen/visa only")).toEqual({
      geoEligibility: "restricted",
      geoRegions: ["us"],
    });
  });

  it("does NOT claim eligibility when the employer merely does not require a visa", () => {
    // "not required" says nothing about WHERE they hire. Asserting `eligible`
    // would put a claim in the data the posting never made.
    expect(visaToGeo("US citizenship/visa not required")).toEqual({});
    expect(visaToGeo("Will sponsor")).toEqual({});
    expect(visaToGeo(undefined)).toEqual({});
  });
});

describe("parseYCPayload", () => {
  const jobs = parseYCPayload(html);

  it("extracts the postings", () => {
    expect(jobs.length).toBeGreaterThanOrEqual(20);
  });

  it("tags every row with the persisted source name", () => {
    for (const job of jobs) expect(job.source).toBe("ycombinator");
  });

  it("builds absolute urls", () => {
    for (const job of jobs) expect(job.url).toMatch(/^https:\/\/www\.ycombinator\.com\//);
  });

  it("never sets applyEmail — YC applications go through their own flow", () => {
    for (const job of jobs) expect(job.applyEmail).toBeUndefined();
  });

  it("reads minExperience into minYears", () => {
    const withExp = jobs.filter((j) => j.minYears !== undefined);
    expect(withExp.length).toBeGreaterThan(0);
    for (const job of withExp) expect(job.minYears).toBeGreaterThanOrEqual(0);
  });

  it("does not invent an experience floor for 'Any (new grads ok)'", () => {
    // That string states no numeric floor; deriveExperience must find none.
    const anyGrad = jobs.find((j) => j.experienceText === undefined && j.minYears === undefined);
    expect(anyGrad).toBeDefined();
  });

  it("carries skills through as tags", () => {
    const tagged = jobs.filter((j) => (j.tags ?? []).length > 1);
    expect(tagged.length).toBeGreaterThan(0);
    for (const job of jobs) expect(job.tags).toContain("ycombinator");
  });

  it("marks rows sparse — the payload carries no description", () => {
    for (const job of jobs) expect(job.sparse).toBe(true);
  });

  it("applies the visa restriction where one is stated", () => {
    const restricted = jobs.filter((j) => j.geoEligibility === "restricted");
    expect(restricted.length).toBeGreaterThan(0);
    for (const job of restricted) expect(job.geoRegions).toContain("us");
  });
});
