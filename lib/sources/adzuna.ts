import { RawJob, extractApplyEmail } from "./types";

// Adzuna search API.
// Docs: https://developer.adzuna.com/docs/search   Signup: /signup (free)
//
// Free tier: 25 req/min, 250/day, 1000/week, 2500/month. We stay far inside
// that: COUNTRIES x SEARCHES requests per daily run.
//
// ATTRIBUTION: Adzuna's terms require a visible "Jobs by Adzuna" credit
// wherever their results are displayed. That credit is rendered in the
// dashboard footer (app/dashboard/layout.tsx) - do not remove it.
//
// Adzuna has no worldwide/remote-only query, so we search per-country and
// filter to remote-looking results ourselves. It is a SECONDARY source: its
// job is to catch roles that the remote-only boards miss.
const COUNTRIES = ["gb", "us", "de", "ca", "in"];
const SEARCHES = ["react next.js remote", "full stack typescript remote"];
const RESULTS_PER_PAGE = 30;
const MAX_DAYS_OLD = 14;

type AdzunaJob = {
  id?: string | number;
  title?: string;
  description?: string;
  redirect_url?: string;
  created?: string;
  contract_time?: string;
  contract_type?: string;
  salary_min?: number;
  salary_max?: number;
  salary_is_predicted?: string | number;
  company?: { display_name?: string };
  location?: { display_name?: string; area?: string[] };
  category?: { label?: string; tag?: string };
};

const REMOTE_HINT = /\b(remote|work from home|wfh|distributed|anywhere)\b/i;

function salaryText(j: AdzunaJob): string | undefined {
  if (j.salary_min == null && j.salary_max == null) return undefined;
  // salary_is_predicted="1" means Adzuna guessed it, so label it rather than
  // presenting a guess as a real posted figure.
  const predicted =
    String(j.salary_is_predicted) === "1" ? " (estimated by Adzuna)" : "";
  return `${Math.round(j.salary_min ?? 0).toLocaleString()} - ${Math.round(
    j.salary_max ?? 0
  ).toLocaleString()}${predicted}`;
}

export async function fetchAdzuna(): Promise<RawJob[]> {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  // Not configured is not an error - just skip the source silently.
  if (!appId || !appKey) return [];

  const seen = new Set<string>();
  const out: RawJob[] = [];

  for (const country of COUNTRIES) {
    for (const what of SEARCHES) {
      const params = new URLSearchParams({
        app_id: appId,
        app_key: appKey,
        what,
        results_per_page: String(RESULTS_PER_PAGE),
        max_days_old: String(MAX_DAYS_OLD),
        "content-type": "application/json",
      });
      const res = await fetch(
        `https://api.adzuna.com/v1/api/jobs/${country}/search/1?${params}`,
        { headers: { accept: "application/json" } }
      );
      if (res.status === 429) {
        throw new Error("Adzuna rate limit hit (free tier: 250/day, 2500/month)");
      }
      if (!res.ok) {
        throw new Error(`Adzuna HTTP ${res.status} (${country}, "${what}")`);
      }
      const data = await res.json();
      const jobs: AdzunaJob[] = Array.isArray(data?.results) ? data.results : [];

      for (const j of jobs) {
        const id = j.id != null ? `${country}:${j.id}` : j.redirect_url;
        if (!id || seen.has(id)) continue;
        if (!j.title || !j.redirect_url) continue;

        // Adzuna returns plenty of on-site roles; keep only ones that actually
        // read as remote, since that's the whole point of this system.
        const haystack = `${j.title} ${j.description || ""} ${
          j.location?.display_name || ""
        }`;
        if (!REMOTE_HINT.test(haystack)) continue;

        seen.add(id);
        const created = j.created ? new Date(j.created) : undefined;
        out.push({
          source: "adzuna",
          sourceId: id,
          title: j.title,
          company: j.company?.display_name || "Unknown",
          url: j.redirect_url,
          applyEmail: extractApplyEmail(j.description),
          location: j.location?.display_name || country.toUpperCase(),
          remote: true,
          salaryText: salaryText(j),
          tags: [j.category?.label, j.contract_time, j.contract_type].filter(
            Boolean
          ) as string[],
          description: j.description,
          postedAt:
            created && !Number.isNaN(created.getTime()) ? created : undefined,
        });
      }
    }
  }
  return out;
}
