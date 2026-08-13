import { RawJob, extractApplyEmail } from "./types";

// Jobicy remote-jobs API - open, no key.
// Docs: https://github.com/Jobicy/remote-jobs-api
//
// Their docs ask for at most a few calls per day; more than hourly may get
// access restricted. We make one call per industry per daily run.
const BASE = "https://jobicy.com/api/v2/remote-jobs";
const INDUSTRIES = ["engineering", "dev", "data-science"];
const COUNT = 50; // API max

type JobicyJob = {
  id?: number | string;
  url?: string;
  jobTitle?: string;
  companyName?: string;
  companyLogo?: string;
  jobIndustry?: string | string[];
  jobType?: string | string[];
  jobGeo?: string;
  jobLevel?: string;
  jobExcerpt?: string;
  jobDescription?: string;
  pubDate?: string;
  annualSalaryMin?: number | string | null;
  annualSalaryMax?: number | string | null;
  salaryCurrency?: string;
};

function asArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function salaryText(j: JobicyJob): string | undefined {
  const lo = j.annualSalaryMin;
  const hi = j.annualSalaryMax;
  if (lo == null && hi == null) return undefined;
  return `${j.salaryCurrency || ""} ${lo ?? "?"} - ${hi ?? "?"} /year`.trim();
}

export async function fetchJobicy(): Promise<RawJob[]> {
  const seen = new Set<string>();
  const out: RawJob[] = [];

  for (const industry of INDUSTRIES) {
    const res = await fetch(
      `${BASE}?count=${COUNT}&geo=anywhere&industry=${encodeURIComponent(industry)}`,
      { headers: { accept: "application/json" } }
    );
    if (!res.ok) throw new Error(`Jobicy HTTP ${res.status} (industry=${industry})`);
    const data = await res.json();
    // Envelope is documented loosely; accept either {jobs:[...]} or a bare array.
    const jobs: JobicyJob[] = Array.isArray(data)
      ? data
      : Array.isArray(data?.jobs)
        ? data.jobs
        : [];

    for (const j of jobs) {
      const id = j.id != null ? String(j.id) : j.url;
      if (!id || seen.has(id)) continue;
      if (!j.jobTitle || !j.url) continue;
      seen.add(id);

      const pub = j.pubDate ? new Date(j.pubDate) : undefined;
      out.push({
        source: "jobicy",
        sourceId: id,
        title: j.jobTitle,
        company: j.companyName || "Unknown",
        companyUrl: j.companyLogo || undefined,
        url: j.url,
        applyEmail: extractApplyEmail(j.jobDescription || j.jobExcerpt),
        location: j.jobGeo || "Remote",
        remote: true,
        salaryText: salaryText(j),
        tags: [
          ...asArray(j.jobIndustry),
          ...asArray(j.jobType),
          ...(j.jobLevel ? [j.jobLevel] : []),
        ].filter(Boolean),
        description: j.jobDescription || j.jobExcerpt,
        postedAt: pub && !Number.isNaN(pub.getTime()) ? pub : undefined,
      });
    }
  }
  return out;
}
