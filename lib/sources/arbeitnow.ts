import { RawJob, RawLead, extractApplyEmail } from "./types";

// Arbeitnow public Job Board API - no key required.
// https://www.arbeitnow.com/api/job-board-api
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- shape is an external, untyped API response
export async function fetchArbeitnowRaw(): Promise<any[]> {
  const res = await fetch("https://www.arbeitnow.com/api/job-board-api");
  if (!res.ok) throw new Error(`Arbeitnow HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.data) ? data.data : [];
}

export async function fetchArbeitnow(): Promise<RawJob[]> {
  const data = await fetchArbeitnowRaw();
  return data
    .filter((d) => d.remote) // remote-only for the jobs pipeline
    .map((d): RawJob => ({
      source: "arbeitnow",
      sourceId: d.slug,
      title: d.title,
      company: d.company_name || "Unknown",
      url: d.url,
      applyEmail: extractApplyEmail(d.description),
      location: d.location || "Remote",
      remote: true,
      tags: Array.isArray(d.tags) ? d.tags : [],
      description: d.description,
      postedAt: d.created_at ? new Date(d.created_at * 1000) : undefined,
    }));
}

// Arbeitnow tags some postings "contract"/"freelance" - surface those as
// leads too, since they're closer to gig work than full-time roles.
export async function fetchArbeitnowContractLeads(): Promise<RawLead[]> {
  const data = await fetchArbeitnowRaw();
  return data
    .filter((d) =>
      Array.isArray(d.job_types) &&
      d.job_types.some((t: string) => /contract|freelance/i.test(t))
    )
    .map((d): RawLead => ({
      source: "arbeitnow_contract",
      sourceId: d.slug,
      title: d.title,
      clientOrCompany: d.company_name,
      url: d.url,
      contactEmail: extractApplyEmail(d.description),
      description: d.description,
      postedAt: d.created_at ? new Date(d.created_at * 1000) : undefined,
    }));
}
