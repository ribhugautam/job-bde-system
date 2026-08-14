import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseIndeedAlert } from "@/lib/infra/sources/email/indeed";

const html = readFileSync("tests/fixtures/alerts/indeed.html", "utf8");

describe("parseIndeedAlert against a real digest", () => {
  const jobs = parseIndeedAlert(html);

  it("finds one entry per distinct job key, not one per anchor", () => {
    // The fixture holds 38 anchors across 19 distinct jk= values.
    expect(jobs.length).toBe(19);
  });

  it("extracts clean titles, never the glued whole card", () => {
    for (const job of jobs) {
      expect(job.title.length).toBeLessThan(90);
      expect(job.title).not.toMatch(/easily apply|just posted|days? ago/i);
    }
  });

  it("never stores a company rating as the location", () => {
    // "TestprepKart" has a 3.5 rating line that shifts every later field.
    for (const job of jobs) {
      expect(job.location ?? "").not.toMatch(/^\d\.\d$/);
      expect(job.company).not.toMatch(/^\d\.\d$/);
    }
  });

  it("reads the rating-shifted card correctly", () => {
    const shifted = jobs.find((j) => j.company === "TestprepKart");
    expect(shifted).toBeDefined();
    expect(shifted!.title).toBe("Web Developer");
    expect(shifted!.location).toBe("Greater Noida, Uttar Pradesh");
    expect(shifted!.salaryText).toBe("From ₹25,000 a month");
  });

  it("flags 'Easily apply' as easyApply", () => {
    expect(jobs.some((j) => j.easyApply === true)).toBe(true);
  });

  it("captures the description snippet, so these are not scored title-only", () => {
    const withDesc = jobs.filter((j) => (j.description ?? "").length > 20);
    // Every one of the 19 fixture cards carries a description snippet.
    expect(withDesc.length).toBe(19);
  });

  it("does not let a description's embedded pay figure steal it as a salary line", () => {
    // NoTempMail's description reads "...Pay: From ₹10,000.00 per month.",
    // which itself looks like a salary line. The classifier must still keep
    // it as the description, not discard it as a duplicate salary match.
    const job = jobs.find((j) => j.company === "NoTempMail");
    expect(job).toBeDefined();
    expect(job!.description).toBeDefined();
    expect(job!.description!.length).toBeGreaterThan(20);
    expect(job!.salaryText).toBe("From ₹10,000 a month");
  });

  it("builds a tracking-free canonical url from the job key", () => {
    for (const job of jobs) {
      expect(job.url).toMatch(/^https:\/\/[a-z.]*indeed\.com\/viewjob\?jk=[a-f0-9]+$/);
      expect(job.url).not.toContain("qd=");
    }
  });

  it("uses the job key as the id", () => {
    for (const job of jobs) expect(job.id).toMatch(/^[a-f0-9]+$/);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
  });

  it("classifies a remote listing", () => {
    const remote = jobs.find((j) => j.company === "Yaarify");
    expect(remote?.location).toBe("Remote");
    expect(remote?.arrangement).toBe("remote");
  });
});
