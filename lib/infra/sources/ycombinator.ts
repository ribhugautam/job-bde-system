import { deriveExperience } from "@/lib/domain/facts";
import type { GeoEligibility } from "@/lib/domain/facts";
import type { RawJob } from "@/lib/domain/types";

// ---------------------------------------------------------------------------
// Y Combinator's public jobs board.
//
// The page is server-rendered by Inertia, which embeds the whole payload as
// JSON in a `data-page` attribute. This is a plain unauthenticated GET of a
// public page — no login, no cookie, no session, and no anti-bot behaviour of
// any kind. A non-200 is an acceptable outcome: the source yields nothing that
// run and the rest of the pipeline carries on.
//
// The payload is unusually rich. `minExperience` and `visa` are STATED facts
// rather than prose we have to infer from, which makes them better evidence
// than anything the location text can give us.
// ---------------------------------------------------------------------------

const ROLE = "eng";
const PAGE_URL = `https://www.ycombinator.com/jobs/role/${ROLE}`;
const BASE = "https://www.ycombinator.com";

// Descriptive on purpose — a server operator reading their logs should be able
// to tell what this is and that it is a small personal tool, not a crawler.
const USER_AGENT =
  "job-bde-system/1.0 (personal job-search assistant; unauthenticated public page fetch)";

const FETCH_TIMEOUT_MS = 20_000;

type YCPosting = {
  id?: number | string;
  title?: string;
  url?: string;
  location?: string;
  minExperience?: string;
  visa?: string;
  skills?: string[];
  companyName?: string;
  type?: string;
};

/**
 * Maps YC's visa field onto geographic eligibility.
 *
 * ONLY an explicit US-only requirement is a restriction. "not required" and
 * "Will sponsor" say the employer will not block on visa status — which is not
 * the same as saying where they hire. Reading either as `eligible` would put a
 * claim in the data that the posting never made, and this system's governing
 * rule is that an unstated fact stays unknown.
 */
export function visaToGeo(
  visa?: string
): { geoEligibility?: GeoEligibility; geoRegions?: string[] } {
  if (!visa) return {};
  if (/us\s+citizen(ship)?\/?visa\s+only|us\s+citizen\/visa\s+only/i.test(visa)) {
    return { geoEligibility: "restricted", geoRegions: ["us"] };
  }
  return {};
}

/** Decodes the HTML-escaped Inertia payload out of the `data-page` attribute. */
function readPayload(html: string): { jobPostings?: YCPosting[] } | undefined {
  const match = html.match(/data-page="([^"]+)"/);
  if (!match) return undefined;
  const decoded = match[1]
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  try {
    return JSON.parse(decoded).props;
  } catch {
    return undefined;
  }
}

export function parseYCPayload(html: string): RawJob[] {
  const props = readPayload(html);
  const postings = props?.jobPostings ?? [];
  const out: RawJob[] = [];

  for (const p of postings) {
    const id = p.id !== undefined ? String(p.id) : undefined;
    if (!id || !p.title || !p.companyName) continue;

    // "3+ years" -> 3. "Any (new grads ok)" states no numeric floor and
    // correctly yields nothing.
    const experience = deriveExperience(p.minExperience ?? "");

    out.push({
      source: "ycombinator",
      sourceId: id,
      title: p.title,
      company: p.companyName,
      url: p.url ? `${BASE}${p.url}` : `${BASE}/jobs`,
      // YC applications go through their own account flow, so these can never
      // auto-send; they land in the manual apply queue.
      applyEmail: undefined,
      location: p.location,
      tags: ["ycombinator", ...(p.skills ?? [])],
      minYears: experience.minYears,
      maxYears: experience.maxYears,
      experienceText: experience.experienceText,
      ...visaToGeo(p.visa),
      // The listing payload carries no description; the job is scored on title,
      // skills and location until something richer arrives.
      description: undefined,
      sparse: true,
    });
  }

  return out;
}

export async function fetchYCombinator(): Promise<RawJob[]> {
  const res = await fetch(PAGE_URL, {
    method: "GET",
    credentials: "omit",
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
  });
  if (!res.ok) {
    throw new Error(`ycombinator: HTTP ${res.status}`);
  }
  return parseYCPayload(await res.text());
}
