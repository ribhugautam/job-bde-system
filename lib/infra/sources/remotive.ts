import { RawJob, extractApplyEmail } from "./types";

// Remotive public JSON API - no key required.
// https://remotive.com/api/remote-jobs
const SEARCHES = ["react", "next.js", "node.js", "flutter", "ai engineer", "llm"];

export async function fetchRemotive(): Promise<RawJob[]> {
  const seen = new Set<string>();
  const out: RawJob[] = [];
  for (const search of SEARCHES) {
    const res = await fetch(
      `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(search)}`
    );
    if (!res.ok) throw new Error(`Remotive HTTP ${res.status} (search=${search})`);
    const data = await res.json();
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    for (const j of jobs) {
      const id = String(j.id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        source: "remotive",
        sourceId: id,
        title: j.title,
        company: j.company_name || "Unknown",
        companyUrl: j.company_logo_url || undefined,
        url: j.url,
        applyEmail: extractApplyEmail(j.description),
        location: j.candidate_required_location || "Remote",
        remote: true,
        salaryText: j.salary || undefined,
        tags: Array.isArray(j.tags) ? j.tags : [],
        description: j.description,
        postedAt: j.publication_date ? new Date(j.publication_date) : undefined,
      });
    }
  }
  return out;
}
