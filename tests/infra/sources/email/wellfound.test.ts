import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseWellfoundAlert, wellfoundJobId } from "@/lib/infra/sources/email/wellfound";

const html = readFileSync("tests/fixtures/alerts/wellfound.html", "utf8");

describe("parseWellfoundAlert against a real digest", () => {
  const jobs = parseWellfoundAlert(html);

  it("finds the jobs the subject line promised", () => {
    // Subject: "New jobs: Full Stack Engineer at Seamless.finance and 3 more jobs"
    expect(jobs.length).toBeGreaterThanOrEqual(4);
  });

  it("extracts a clean title and company", () => {
    const first = jobs[0];
    expect(first.title).toBe("Full Stack Engineer");
    expect(first.company).toBe("Seamless.finance");
  });

  it("never leaves the employee-count suffix on the company", () => {
    for (const job of jobs) {
      expect(job.company).not.toMatch(/employees/i);
      expect(job.company).not.toContain("/");
    }
  });

  it("reads arrangement, location, salary and experience from the facts line", () => {
    const first = jobs[0];
    expect(first.arrangement).toBe("remote");
    expect(first.location).toBe("India");
    expect(first.salaryText).toBe("₹3L–₹7L");
    expect(first.minYears).toBe(3);
  });

  it("derives a stable id that does not embed a per-send tracking token", () => {
    for (const job of jobs) {
      expect(job.id).not.toMatch(/links\.wellfound\.com/);
      expect(job.id.length).toBeGreaterThan(0);
    }
    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
  });

  it("gives every job a url", () => {
    for (const job of jobs) expect(job.url).toMatch(/^https?:\/\//);
  });
});

describe("wellfoundJobId", () => {
  it("is stable across formatting differences", () => {
    expect(wellfoundJobId("Seamless.finance", "Full Stack Engineer")).toBe(
      wellfoundJobId("  Seamless.finance  ", "Full Stack Engineer")
    );
  });

  it("distinguishes different roles at one company", () => {
    expect(wellfoundJobId("Acme", "Backend Engineer")).not.toBe(
      wellfoundJobId("Acme", "Frontend Engineer")
    );
  });
});

describe("the facts line", () => {
  it("treats 'Onsite or remote' as remote — the employer permits it", () => {
    const jobs = parseWellfoundAlert(html);
    const flexible = jobs.find((j) => /onsite or remote/i.test(j.location ?? "") || j.arrangement === "remote");
    expect(flexible).toBeDefined();
  });

  it("pins the fix on the job that actually says 'Onsite or remote': Neural Niti's posting must read remote, not onsite", () => {
    // deriveArrangement checks HYBRID -> ONSITE -> REMOTE in that order, so the
    // raw facts-line text "Onsite or remote, Faridabad, Remote (Everywhere)"
    // would match ONSITE_RE ("onsite") before REMOTE_RE is ever tried. The
    // parser must normalize that leading phrase to "remote" BEFORE calling
    // deriveArrangement — this test fails if that normalization regresses.
    const jobs = parseWellfoundAlert(html);
    const job = jobs.find((j) => j.company === "Neural Niti");
    expect(job).toBeDefined();
    expect(job?.title).toBe("Full Stack Software Engineer");
    expect(job?.arrangement).toBe("remote");
    expect(job?.location).toBe("Faridabad, Remote (Everywhere)");
    expect(job?.minYears).toBe(5);
  });
});
