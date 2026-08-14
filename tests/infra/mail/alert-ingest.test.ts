import { describe, it, expect } from "vitest";
import { toRawJobs } from "@/lib/infra/mail/alert-ingest";
import type { AlertSource, ParsedAlertJob } from "@/lib/infra/sources/email/types";

const SOURCE: AlertSource = {
  name: "test_alert",
  fromDomain: "example.invalid",
  days: 3,
  parse: () => [],
  tags: ["test-alert"],
};

function parsed(over: Partial<ParsedAlertJob> = {}): ParsedAlertJob {
  return {
    id: "abc",
    title: "Full Stack Engineer",
    company: "Acme",
    url: "https://example.invalid/jobs/abc",
    ...over,
  };
}

describe("toRawJobs", () => {
  it("carries the source name onto every row", () => {
    const [job] = toRawJobs(SOURCE, [parsed()]);
    expect(job.source).toBe("test_alert");
    expect(job.sourceId).toBe("abc");
  });

  it("never sets applyEmail, so an alert job can never auto-send", () => {
    const [job] = toRawJobs(SOURCE, [parsed()]);
    expect(job.applyEmail).toBeUndefined();
  });

  it("derives remote from arrangement, and leaves it undefined when unknown", () => {
    expect(toRawJobs(SOURCE, [parsed({ arrangement: "remote" })])[0].remote).toBe(true);
    expect(toRawJobs(SOURCE, [parsed({ arrangement: "onsite" })])[0].remote).toBe(false);
    expect(toRawJobs(SOURCE, [parsed({ arrangement: "hybrid" })])[0].remote).toBe(false);
    expect(toRawJobs(SOURCE, [parsed({ arrangement: "unknown" })])[0].remote).toBeUndefined();
    expect(toRawJobs(SOURCE, [parsed({})])[0].remote).toBeUndefined();
  });

  it("marks a job sparse only when no description came through", () => {
    expect(toRawJobs(SOURCE, [parsed()])[0].sparse).toBe(true);
    expect(toRawJobs(SOURCE, [parsed({ description: "We need React." })])[0].sparse).toBe(false);
  });

  it("passes structured facts through untouched", () => {
    const [job] = toRawJobs(SOURCE, [parsed({ minYears: 3, salaryText: "₹3L–₹7L", easyApply: true })]);
    expect(job.minYears).toBe(3);
    expect(job.salaryText).toBe("₹3L–₹7L");
    expect(job.easyApply).toBe(true);
  });

  it("applies the source tags", () => {
    expect(toRawJobs(SOURCE, [parsed()])[0].tags).toEqual(["test-alert"]);
  });

  it("carries postedAt through onto the RawJob, and leaves it undefined when absent", () => {
    const date = new Date("2026-08-10T00:00:00Z");
    expect(toRawJobs(SOURCE, [parsed({ postedAt: date })])[0].postedAt).toEqual(date);
    expect(toRawJobs(SOURCE, [parsed()])[0].postedAt).toBeUndefined();
  });

  it("drops duplicates by id within one run", () => {
    expect(toRawJobs(SOURCE, [parsed(), parsed()])).toHaveLength(1);
  });
});
