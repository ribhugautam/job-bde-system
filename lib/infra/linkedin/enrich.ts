import * as cheerio from "cheerio";
import type { Settings } from "@/lib/config/settings";

// ---------------------------------------------------------------------------
// Recovering the missing job description for LinkedIn alert jobs.
//
// Alert emails (./alerts.ts) carry a title, company and location but no
// description, which leaves those jobs scored on their title alone. This
// module fills that gap from the job's PUBLIC page.
//
// Stated honestly, because this is the part a reader will be suspicious of:
//   - The request is a plain, unauthenticated GET of
//     https://www.linkedin.com/jobs/view/<id>. No login, no cookie, no stored
//     session, no credentials of any kind are sent or accepted. It is the same
//     page a signed-out visitor gets, and no account is at risk from it.
//   - There is deliberately NO anti-bot behavior: no fingerprint spoofing, no
//     proxy rotation, no header games, no retry storm. The User-Agent below
//     says plainly what this is. Adding evasion would be out of scope and is
//     not wanted here.
//   - If LinkedIn blocks the request (403/429) that is an acceptable outcome,
//     not an error to work around. The job simply stays `sparse` and is scored
//     on its title - exactly the behavior that existed before this module. The
//     calling stage caps how many pages it fetches per day
//     (LINKEDIN_ENRICH_DAILY_CAP) and spaces them out
//     (LINKEDIN_ENRICH_DELAY_MS) so a run can never turn into a burst.
//
// Nothing in here may throw at the caller: a failed enrichment degrades one
// job to title-only scoring, it never fails a pipeline run.
// ---------------------------------------------------------------------------

export type EnrichOutcome = "ok" | "not_found" | "blocked" | "error";

export type EnrichResult = {
  jobId: string;
  description?: string;
  /** hiringOrganization.name from the page's JSON-LD, when it publishes one. */
  company?: string;
  outcome: EnrichOutcome;
  httpStatus?: number;
};

/** Canonical, tracking-free public job page. */
const jobPageUrl = (jobId: string) =>
  `https://www.linkedin.com/jobs/view/${encodeURIComponent(jobId)}`;

// Descriptive on purpose - a server operator reading their logs should be able
// to tell what this is and that it is a small personal tool, not a crawler.
const USER_AGENT =
  "job-bde-system/1.0 (personal job-search assistant; unauthenticated public page fetch)";

// A hung request would stall the pipeline stage, which is the one way a
// best-effort enrichment could actually hurt. Cap it.
const FETCH_TIMEOUT_MS = 15_000;

// Both forms LinkedIn uses: the canonical /jobs/view/<id> path, and the
// /comm/ tracking variant that appears in alert emails.
const JOB_URL_RE = /linkedin\.com\/(?:comm\/)?jobs\/view\/(\d+)/i;
// Search/collection pages carry the id in a query parameter instead.
const CURRENT_JOB_ID_RE = /[?&]currentJobId=(\d+)/i;

/**
 * Pulls the numeric job id out of any LinkedIn job URL.
 * Returns undefined for anything that isn't one - never throws.
 */
export function extractJobId(url: string): string | undefined {
  if (!url) return undefined;
  return url.match(JOB_URL_RE)?.[1] ?? url.match(CURRENT_JOB_ID_RE)?.[1];
}

// Fallback containers, in order of preference. Only consulted when the page
// has no JSON-LD; these class names are LinkedIn's own markup and can change
// at any time, which is exactly why JSON-LD is tried first.
const DESCRIPTION_SELECTORS = [
  ".show-more-less-html__markup",
  ".description__text",
  ".jobs-description__content",
  "#job-details",
];

const HAS_TAG_RE = /<\/?[a-z][^>]*>/i;
const HAS_ESCAPED_TAG_RE = /&lt;\/?[a-z][^&]*&gt;/i;

/** One HTML-to-text pass: decodes entities and turns block markup into lines. */
function stripOnce(html: string): string {
  const $ = cheerio.load(`<div data-strip-root="1">${html}</div>`);
  const root = $("[data-strip-root]");
  root.find("script, style").remove();
  root.find("br").replaceWith("\n");
  root.find("p, div, li, ul, ol, h1, h2, h3, h4, h5, h6, tr").append("\n");
  return root.text();
}

function normalizeText(text: string): string {
  return text
    .replace(/\r/g, "")
    // \u00a0 (non-breaking space) is all over LinkedIn's markup and is
    // invisible in a diff, so collapse it along with ordinary spaces.
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * HTML -> readable text.
 *
 * Usually one pass. LinkedIn's JSON-LD stores the description as HTML that is
 * itself entity-escaped ("&lt;p&gt;Build things&lt;/p&gt;"), so that case needs
 * two: one to decode the entities into real markup, one to strip it.
 *
 * The second pass runs only when the input has escaped tags and no real ones,
 * which is exactly the JSON-LD shape. Running it whenever tags appear after
 * decoding would be wrong: a normal description that mentions "&lt;canvas&gt;"
 * would silently lose the word.
 */
function toReadableText(html: string): string {
  const doubleEncoded = !HAS_TAG_RE.test(html) && HAS_ESCAPED_TAG_RE.test(html);
  const out = doubleEncoded ? stripOnce(stripOnce(html)) : stripOnce(html);
  return normalizeText(out);
}

function isJobPosting(node: unknown): node is Record<string, unknown> {
  if (!node || typeof node !== "object") return false;
  const type = (node as Record<string, unknown>)["@type"];
  return Array.isArray(type)
    ? type.includes("JobPosting")
    : type === "JobPosting";
}

/** Flattens arrays and @graph wrappers into a plain list of nodes. */
function collectNodes(value: unknown, out: unknown[]): void {
  if (Array.isArray(value)) {
    for (const v of value) collectNodes(v, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  out.push(value);
  const graph = (value as Record<string, unknown>)["@graph"];
  if (graph) collectNodes(graph, out);
}

type JsonLdFacts = { description?: string; company?: string };

/**
 * Reads the description AND the hiring organisation from the page's JSON-LD.
 *
 * Both come off the same JobPosting node, so reading them together costs
 * nothing extra. The company matters because LinkedIn alert emails parsed by
 * the OLD parser stored "Unknown" — see repairMangledCard in ./alerts.ts, which
 * can recover a mangled card's location and arrangement from stored text but
 * provably cannot recover its employer.
 */
function jsonLdFacts($: cheerio.CheerioAPI): JsonLdFacts {
  for (const script of $('script[type="application/ld+json"]').toArray()) {
    const raw = $(script).text().trim();
    if (!raw) continue;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      // Truncated or non-JSON blocks are common; try the next one.
      continue;
    }
    const nodes: unknown[] = [];
    collectNodes(data, nodes);
    for (const node of nodes) {
      if (!isJobPosting(node)) continue;

      const org = (node as { hiringOrganization?: unknown }).hiringOrganization;
      const name =
        org && typeof org === "object"
          ? (org as { name?: unknown }).name
          : undefined;
      const company =
        typeof name === "string" && name.trim() ? name.trim() : undefined;

      const description = node.description;
      if (typeof description === "string" && description.trim()) {
        return { description, company };
      }
      // A node with a company but no description is still worth reporting:
      // the caller records not_found for the description and keeps the name.
      if (company) return { description: undefined, company };
    }
  }
  return {};
}

export type ParsedJobPage = { description?: string; company?: string };

/**
 * Extracts the job description and hiring organisation from a job page.
 *
 * Prefers the JSON-LD JobPosting block: it is a published, structured contract
 * that changes far less often than LinkedIn's CSS class names. The class-name
 * selectors are only a fallback for the DESCRIPTION when a page ships without
 * one in its JSON-LD; the company name always comes from JSON-LD alone. So a
 * page that falls through to the selectors still returns the company
 * alongside the description whenever the JSON-LD stated one - not a
 * description alone.
 *
 * Returns undefined fields when the page carries neither (a removed listing, or
 * a page that wants a login) rather than guessing.
 */
export function parseJobPage(html: string): ParsedJobPage {
  if (!html || !html.trim()) return { description: undefined, company: undefined };

  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(html);
  } catch {
    return { description: undefined, company: undefined };
  }

  const fromJsonLd = jsonLdFacts($);
  if (fromJsonLd.description) {
    const text = toReadableText(fromJsonLd.description);
    if (text) return { description: text, company: fromJsonLd.company };
  }

  for (const selector of DESCRIPTION_SELECTORS) {
    const el = $(selector).first();
    if (!el.length) continue;
    const text = toReadableText(el.html() ?? "");
    if (text) return { description: text, company: fromJsonLd.company };
  }

  return { description: undefined, company: fromJsonLd.company };
}

/**
 * Fetches one public job page and extracts its description.
 *
 * Never throws. Outcomes are reported as they are:
 *   ok         200 and a description we could actually read
 *   not_found  404/410, or a 200 page with no description on it
 *   blocked    403/429 - LinkedIn declined to serve us; back off, don't evade
 *   error      any other status, a network failure, or a timeout
 */
export async function fetchJobDescription(jobId: string): Promise<EnrichResult> {
  try {
    const res = await fetch(jobPageUrl(jobId), {
      method: "GET",
      // No cookies, no auth header, no session - see the note at the top.
      credentials: "omit",
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9",
      },
    });

    const httpStatus = res.status;

    if (httpStatus === 404 || httpStatus === 410) {
      return { jobId, outcome: "not_found", httpStatus };
    }
    if (httpStatus === 403 || httpStatus === 429) {
      return { jobId, outcome: "blocked", httpStatus };
    }
    if (!res.ok) {
      return { jobId, outcome: "error", httpStatus };
    }

    const { description, company } = parseJobPage(await res.text());
    if (!description) {
      // 200 but nothing readable: an expired listing or an auth wall. Saying
      // "not_found" is honest; the job stays title-only either way. The company
      // still rides along — it is useful even when the description is not there.
      return { jobId, company, outcome: "not_found", httpStatus };
    }

    return { jobId, description, company, outcome: "ok", httpStatus };
  } catch {
    return { jobId, outcome: "error" };
  }
}

/** Plain delay. Exported so the calling stage can pace itself between pages. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** The configured gap between two page fetches, in milliseconds. */
export function enrichDelayMs(settings: Settings): number {
  return settings.LINKEDIN_ENRICH_DELAY_MS;
}

/** `await enrichDelay()` between fetches - never fetch two pages back to back. */
export function enrichDelay(settings: Settings): Promise<void> {
  return sleep(enrichDelayMs(settings));
}

/**
 * Everything the calling pipeline stage needs to decide whether and how much.
 *
 * Takes settings rather than reading them, so this stays synchronous and the
 * stage keeps control of when the settings row is loaded -- once per run, not
 * once per job.
 */
export function enrichSettings(settings: Settings): {
  enabled: boolean;
  dailyCap: number;
  delayMs: number;
} {
  return {
    enabled: settings.ENABLE_LINKEDIN_ENRICH,
    dailyCap: settings.LINKEDIN_ENRICH_DAILY_CAP,
    delayMs: settings.LINKEDIN_ENRICH_DELAY_MS,
  };
}
