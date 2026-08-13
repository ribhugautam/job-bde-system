import { RawJob, extractApplyEmail } from "./types";

// RemoteOK public JSON API - no key required.
// https://remoteok.com/api  (documented, publicly used by many aggregators)
// The first array element is a legal/notice object, not a job - skip it.
export async function fetchRemoteOk(): Promise<RawJob[]> {
  const res = await fetch("https://remoteok.com/api", {
    headers: { "User-Agent": "Mozilla/5.0 (job-search-bot; contact via listing)" },
  });
  if (!res.ok) throw new Error(`RemoteOK HTTP ${res.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- shape is an external, untyped API response
  const data = (await res.json()) as any[];
  return data
    .filter((d) => d && d.id && d.position)
    .map((d): RawJob => ({
      source: "remoteok",
      sourceId: String(d.id),
      title: d.position,
      company: d.company || "Unknown",
      companyUrl: d.company_url || undefined,
      url: d.url ? `https://remoteok.com${d.url.startsWith("/") ? "" : "/"}${d.url.replace(/^https?:\/\/remoteok\.com/, "")}` : d.apply_url,
      applyEmail: extractApplyEmail(d.description),
      location: d.location || "Remote",
      remote: true,
      salaryText:
        d.salary_min && d.salary_max
          ? `$${d.salary_min} - $${d.salary_max}`
          : undefined,
      tags: Array.isArray(d.tags) ? d.tags : [],
      description: d.description,
      postedAt: d.date ? new Date(d.date) : undefined,
    }));
}
