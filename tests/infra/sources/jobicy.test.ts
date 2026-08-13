import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchJobicy } from "@/lib/infra/sources/jobicy";

// Regression cover for a live breakage. The request carried `geo=anywhere`,
// which Jobicy rejects outright:
//   {"success":false,"error":"Do not specify 'geo=Anywhere' if you want to get
//    a list of all jobs regardless of region"}
// Every run returned HTTP 400 and zero jobs. Omitting geo is how the API
// expresses "all regions".

afterEach(() => vi.unstubAllGlobals());

function stubJobicy(jobs: unknown[]) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ success: true, jobs }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    })
  );
  return urls;
}

const JOB = {
  id: 1,
  url: "https://jobicy.com/jobs/1",
  jobTitle: "Senior Full Stack Engineer",
  companyName: "Acme",
  jobGeo: "Anywhere",
  jobIndustry: "engineering",
  jobType: "full-time",
  jobDescription: "React, TypeScript. Apply: jobs@acme.example",
  pubDate: "2026-08-12 10:00:00",
  annualSalaryMin: 100000,
  annualSalaryMax: 140000,
  salaryCurrency: "USD",
};

describe("request shape", () => {
  it("never sends a geo parameter", async () => {
    // The whole bug in one assertion.
    const urls = stubJobicy([JOB]);
    await fetchJobicy();
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.toLowerCase(), `geo must not appear in ${url}`).not.toContain(
        "geo="
      );
    }
  });

  it("still requests each industry", async () => {
    const urls = stubJobicy([JOB]);
    await fetchJobicy();
    const joined = urls.join(" ");
    for (const industry of ["engineering", "dev", "data-science"]) {
      expect(joined).toContain(`industry=${industry}`);
    }
  });
});

describe("error reporting", () => {
  it("includes the API's explanation in the thrown message", async () => {
    // The body is what identified the geo problem in seconds; throwing only the
    // status code is what made it take longer than it should have.
    const body = JSON.stringify({
      success: false,
      error: "Do not specify 'geo=Anywhere' ...",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 400 }))
    );
    await expect(fetchJobicy()).rejects.toThrow(/400/);
    await expect(fetchJobicy()).rejects.toThrow(/Do not specify/);
  });
});

describe("mapping", () => {
  it("maps a job and extracts a published apply email", async () => {
    stubJobicy([JOB]);
    const jobs = await fetchJobicy();
    const j = jobs[0];
    expect(j.source).toBe("jobicy"); // persisted name, half the dedupe key
    expect(j.title).toBe("Senior Full Stack Engineer");
    expect(j.company).toBe("Acme");
    expect(j.applyEmail).toBe("jobs@acme.example");
    expect(j.salaryText).toContain("USD");
  });

  it("de-duplicates the same id across industry calls", async () => {
    // All three industry requests return the same job here; it must appear once.
    stubJobicy([JOB]);
    expect(await fetchJobicy()).toHaveLength(1);
  });

  it("skips entries with no title or url rather than emitting junk rows", async () => {
    stubJobicy([{ id: 2, companyName: "NoTitle" }, JOB]);
    const jobs = await fetchJobicy();
    expect(jobs).toHaveLength(1);
  });
});
