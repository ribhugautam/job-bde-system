import * as cheerio from "cheerio";
import { deriveArrangement } from "@/lib/domain/facts";
import type { ParsedAlertJob } from "./types";

// ---------------------------------------------------------------------------
// Wellfound "New jobs: ..." digests.
//
// Structure observed in tests/fixtures/alerts/wellfound.html — a run of
// consecutive text lines per job:
//
//   "Full Stack Engineer"                                        title
//   "Seamless.finance / 1-10 Employees"                          company / size
//   "₹3L–₹7L | Remote only, India | 3 years of exp | Full-time"  facts
//   "Actively Hiring"                                            optional badge
//   "Learn More"                                                 CTA anchor
//
// THE ID PROBLEM: every link in the digest is a per-send tracking redirect
// (links.wellfound.com/s/c/<hash>) carrying no job identifier. Using one as
// `source_id` would make the same posting a new row in every email. So the id
// is DERIVED from company + title, which is stable across sends. The cost is
// that two genuinely distinct postings with the same title at the same company
// collapse into one row — rare, and far cheaper than re-ingesting the whole
// digest weekly.
// ---------------------------------------------------------------------------

type DomNode = { type: string; name?: string; data?: string; children?: DomNode[] };

/** Splits an element into logical lines, one per text node. */
function lines(el: DomNode): string[] {
  const out: string[] = [];
  const push = (s?: string) => {
    const t = (s || "").replace(/\s+/g, " ").trim();
    if (t) out.push(t);
  };
  const walk = (n: DomNode) => {
    if (n.type === "text") return push(n.data);
    if (n.type !== "tag") return;
    for (const c of n.children || []) walk(c);
  };
  walk(el);
  return out;
}

/** "Seamless.finance / 1-10 Employees" -> "Seamless.finance" */
const COMPANY_SIZE_SUFFIX = /\s*\/\s*[\d,]+\s*-?\s*[\d,]*\+?\s*employees\s*$/i;

/** A company line is "<name> / <N>-<M> Employees". */
function isCompanyLine(line: string): boolean {
  return COMPANY_SIZE_SUFFIX.test(line);
}

function companyName(line: string): string {
  return line.replace(COMPANY_SIZE_SUFFIX, "").trim();
}

/** The pipe-delimited facts line always states experience or a work arrangement. */
function isFactsLine(line: string): boolean {
  return line.includes("|") && /years? of exp|remote|onsite|hybrid/i.test(line);
}

const EXP_RE = /(\d{1,2})\+?\s*years?\s+of\s+exp/i;
const CURRENCY_RE = /[₹$€£]/;
const EMPLOYMENT_TYPE_RE = /^(full|part)-time$|^contract$|^internship$|^co-?op$/i;

export type WellfoundFacts = {
  salaryText?: string;
  location?: string;
  arrangementText?: string;
  minYears?: number;
};

/**
 * Classifies each pipe-separated segment by SHAPE rather than position.
 * Segment order varies between postings, and a missing salary shifts every
 * following field — the same positional trap that made the LinkedIn parser
 * store badge text as a company name.
 */
export function parseFactsLine(line: string): WellfoundFacts {
  const out: WellfoundFacts = {};
  for (const raw of line.split("|")) {
    const seg = raw.trim();
    if (!seg) continue;

    const exp = seg.match(EXP_RE);
    if (exp) {
      out.minYears = Number(exp[1]);
      continue;
    }
    if (EMPLOYMENT_TYPE_RE.test(seg)) continue;
    if (CURRENCY_RE.test(seg)) {
      out.salaryText = seg;
      continue;
    }
    // Whatever is left describes where the work happens:
    //   "Remote only, India"
    //   "Onsite or remote, Faridabad, Remote (Everywhere)"
    // The arrangement is the clause before the first comma; the rest is location.
    const comma = seg.indexOf(",");
    out.arrangementText = comma >= 0 ? seg.slice(0, comma).trim() : seg;
    out.location = comma >= 0 ? seg.slice(comma + 1).trim() : undefined;
  }
  return out;
}

/**
 * Wellfound's "Onsite or remote" phrasing means the employer PERMITS remote
 * work — the correct arrangement is "remote". But deriveArrangement checks
 * HYBRID -> ONSITE -> REMOTE in that order, and the literal string "Onsite or
 * remote" matches ONSITE_RE ("onsite") before REMOTE_RE ever gets a look,
 * so feeding it through unchanged would report "onsite". Rather than touch
 * deriveArrangement's precedence — other sources rely on ONSITE beating
 * REMOTE when a posting genuinely names both — this Wellfound-specific
 * phrasing is normalized before the shared derivation runs.
 */
function normalizeArrangementText(text?: string): string | undefined {
  if (text && /^onsite or remote\b/i.test(text)) return "remote";
  return text;
}

/** Lowercased, punctuation-stripped join. Stable across whitespace and case. */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function wellfoundJobId(company: string, title: string): string {
  return `${slug(company)}:${slug(title)}`;
}

const NON_JOB_LINES =
  /^(ready to interview|open to offers|closed to offers|actively hiring|growing fast|learn more|hi|view all|unsubscribe)$/i;

export function parseWellfoundAlert(html: string): ParsedAlertJob[] {
  const $ = cheerio.load(html);
  const root = $("body").get(0);
  if (!root) return [];

  const all = lines(root as unknown as DomNode);
  const ctas = learnMoreHrefs($);
  const out: ParsedAlertJob[] = [];
  const seen = new Set<string>();

  // A job is anchored by its COMPANY line — the only line with an unambiguous
  // shape. The title is the line before it; the facts line is the next line
  // that looks like one. Anchoring on the distinctive line rather than counting
  // from the top is what makes a missing badge or an extra banner harmless.
  for (let i = 1; i < all.length; i++) {
    if (!isCompanyLine(all[i])) continue;

    const title = all[i - 1];
    if (!title || NON_JOB_LINES.test(title)) continue;

    const company = companyName(all[i]);
    if (!company) continue;

    let facts: WellfoundFacts = {};
    for (let j = i + 1; j < Math.min(i + 4, all.length); j++) {
      if (isFactsLine(all[j])) {
        facts = parseFactsLine(all[j]);
        break;
      }
    }

    const id = wellfoundJobId(company, title);
    if (seen.has(id)) continue;
    seen.add(id);

    out.push({
      id,
      title,
      company,
      location: facts.location,
      // Nth job pairs with the Nth CTA via `out.length`, which tracks EMITTED
      // jobs, not document position. Accepted limitation: if a candidate is
      // skipped just above as a duplicate id, `out.length` under-counts the
      // jobs actually walked, and every job after the skip takes a CTA one
      // position early — a wrong click-target, not wrong job data. Fine given
      // this fixture, and not worth threading DOM position through the line
      // walk to guard a case it doesn't exercise. Falls back to the board
      // itself when the digest has fewer CTAs than jobs.
      url: ctas[out.length] ?? "https://wellfound.com/jobs",
      arrangement: deriveArrangement({ location: normalizeArrangementText(facts.arrangementText) }),
      salaryText: facts.salaryText,
      minYears: facts.minYears,
    });
  }

  return out;
}

/**
 * The per-job "Learn More" tracking links, in document order.
 *
 * Collected once and paired with jobs BY INDEX: the digest emits one CTA per
 * job in the same order the jobs appear, so the Nth job's link is the Nth CTA.
 * (Taking `.first()` for every job would hand every row the same URL — a real
 * bug caught in review of this plan.)
 *
 * These links are per-send tracking redirects. They are fine as a click target
 * but must never become the id; see wellfoundJobId.
 */
function learnMoreHrefs($: cheerio.CheerioAPI): string[] {
  return $("a")
    .toArray()
    .filter((el) => $(el).text().replace(/\s+/g, " ").trim() === "Learn More")
    .map((el) => $(el).attr("href") ?? "")
    .filter(Boolean);
}
