import { RawJob, extractApplyEmail } from "./types";

// Himalayas remote-jobs API - fully open, no key, no signup.
// Docs: https://himalayas.app/docs/remote-jobs-api
//
// Remote-only and genuinely worldwide, which makes it the best-fit source in
// the set. Data is cached and refreshed every 24h upstream, so polling more
// than once a day buys nothing - the daily cron is exactly right.
const SEARCH_URL = "https://himalayas.app/jobs/api/search";
const SEARCHES = [
  "full stack engineer",
  "next.js",
  "react typescript",
  "node.js",
  "flutter",
  "ai engineer",
  "llm engineer",
];

type HimalayasJob = {
  guid?: string;
  title?: string;
  companyName?: string;
  companySlug?: string;
  companyLogo?: string;
  applicationLink?: string;
  excerpt?: string;
  description?: string;
  employmentType?: string;
  minSalary?: number | null;
  maxSalary?: number | null;
  salaryPeriod?: string;
  currency?: string;
  categories?: string[];
  seniority?: string[];
  locationRestrictions?: { name?: string }[];
  pubDate?: number; // unix ms
};

function salaryText(j: HimalayasJob): string | undefined {
  if (j.minSalary == null && j.maxSalary == null) return undefined;
  const cur = j.currency || "";
  const period = j.salaryPeriod ? `/${j.salaryPeriod}` : "";
  const lo = j.minSalary != null ? j.minSalary.toLocaleString() : "?";
  const hi = j.maxSalary != null ? j.maxSalary.toLocaleString() : "?";
  return `${cur} ${lo} - ${hi}${period}`.trim();
}

function locationText(j: HimalayasJob): string {
  const names = (j.locationRestrictions || [])
    .map((l) => l?.name)
    .filter(Boolean) as string[];
  // Empty locationRestrictions means worldwide, per the API docs.
  return names.length ? names.join(", ") : "Worldwide";
}

export async function fetchHimalayas(): Promise<RawJob[]> {
  const seen = new Set<string>();
  const out: RawJob[] = [];

  for (const q of SEARCHES) {
    const res = await fetch(`${SEARCH_URL}?q=${encodeURIComponent(q)}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Himalayas HTTP ${res.status} (q=${q})`);
    const data = await res.json();
    const jobs: HimalayasJob[] = Array.isArray(data?.jobs) ? data.jobs : [];

    for (const j of jobs) {
      // guid is the documented unique id; fall back to the apply link so a
      // schema change can't silently collapse every job into one row.
      const id = j.guid || j.applicationLink;
      if (!id || seen.has(id)) continue;
      if (!j.title || !j.applicationLink) continue;
      seen.add(id);

      out.push({
        source: "himalayas",
        sourceId: id,
        title: j.title,
        company: j.companyName || "Unknown",
        companyUrl: j.companyLogo || undefined,
        url: j.applicationLink,
        applyEmail: extractApplyEmail(j.description || j.excerpt),
        location: locationText(j),
        remote: true,
        salaryText: salaryText(j),
        tags: [
          ...(j.categories || []),
          ...(j.seniority || []),
          ...(j.employmentType ? [j.employmentType] : []),
        ].filter(Boolean),
        description: j.description || j.excerpt,
        postedAt: j.pubDate ? new Date(j.pubDate) : undefined,
      });
    }
  }
  return out;
}
