import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import * as cheerio from "cheerio";
import { RawJob } from "../sources/types";
import { getEnv } from "@/lib/config/env";

// ---------------------------------------------------------------------------
// LinkedIn job alerts, read out of your OWN Gmail over IMAP.
//
// This module never authenticates to LinkedIn and never scrapes a logged-in
// surface. LinkedIn has no public jobs API, and its User Agreement prohibits
// automated access to member-only pages - doing that risks the account this
// whole system points recruiters at. What it does instead: you create saved
// searches on LinkedIn and switch on email alerts; those emails arrive in your
// mailbox, which is your own data, and we parse them there.
//
// Consequences of that choice, stated plainly:
//   - Alert emails carry a title, company, location and link. They do NOT
//     carry the job description, so these jobs are flagged `sparse`, which
//     lib/domain/scoring/score.ts surfaces as "scored on title only" and
//     lib/pipeline/ takes into account when deciding what is worth acting on.
//   - `sparse` is a fallback, not the goal: lib/infra/linkedin/enrich.ts tries
//     to recover the description from the job's public, unauthenticated page
//     (no login, no cookie, no session). When that succeeds the job is scored
//     on real evidence; when it fails the job stays title-only, which is the
//     pre-existing behavior.
//   - There is no apply-by-email address, so these NEVER auto-send. They land
//     in the dashboard scored, with a drafted cover letter, for you to apply.
//   - The work arrangement is stated inside the location line ("(Hybrid)",
//     "(On-site)"), so `remote` is derived from it and left undefined when the
//     email doesn't say. It is never assumed - see inferRemote().
//
// SETUP:
//   1. On LinkedIn, run a job search you like -> toggle "Job alert" on ->
//      set delivery to Email, daily.
//   2. Set ENABLE_LINKEDIN_ALERTS=1. IMAP_USER/IMAP_PASSWORD default to
//      GMAIL_USER/GMAIL_APP_PASSWORD - the same app password already used for
//      sending also works for IMAP.
// ---------------------------------------------------------------------------

const JOB_URL_RE = /linkedin\.com\/(?:comm\/)?jobs\/view\/(\d+)/i;

// Decorative tails LinkedIn hangs off button labels ("See all jobs ›").
const TRAILING_CHROME_RE = /[\s>›»→•·|]+$/u;

// Multi-word openers that only ever begin navigation. "See all", "View job",
// "Show more" - no real job title starts that way, so a prefix match is safe
// here and it catches the label variants without enumerating all of them.
const NAV_PREFIX_RE = /^(see|view|show)\s+(all|more|this job|jobs|job)\b/i;

// Single ambiguous words must match the WHOLE anchor. This is the fix for a
// real data-loss bug: the old pattern prefix-matched "apply|manage|settings|
// help|linkedin", which silently discarded genuine jobs called "Manager,
// Platform Engineering", "Help Desk Engineer", "Applied Scientist" or
// "LinkedIn Marketing Specialist". A job title is essentially never exactly
// equal to one of these strings, so equality is both safe and strict.
const NAV_EXACT_RE =
  /^(apply|apply now|easy apply|apply on company website|unsubscribe|manage|manage alerts|manage job alerts|manage email preferences|settings|email settings|help|help center|linkedin|linkedin corporation|see all|view all|view job|see more|show more|new jobs?|\d+ new jobs?|view \d+ new jobs?)$/i;

/**
 * True when an anchor's text is navigation chrome rather than a job title.
 *
 * INEVITABLY INCOMPLETE: this is an allowlist of the labels LinkedIn uses
 * today. A new button wording ("Save this job") would not be recognised, and
 * because the de-duplication below keeps the LONGEST anchor text for a job id,
 * an unrecognised long label can beat a short real title. Exercising that
 * needs a template change to look at, so it is documented rather than
 * speculatively designed around.
 */
export function isNavigationText(text: string): boolean {
  const t = text.replace(TRAILING_CHROME_RE, "").trim();
  if (!t) return true;
  return NAV_PREFIX_RE.test(t) || NAV_EXACT_RE.test(t);
}

/**
 * Badge and counter lines LinkedIn interleaves between the job title and the
 * company name.
 *
 * These matter more than they look. Company and location are read positionally
 * - "the first line after the title" - so a single unfiltered badge shifts
 * every field by one and the job is stored with company "Promoted" and
 * location "Vercel". That fails WRONG rather than empty, which nothing
 * downstream can detect.
 *
 * INEVITABLY INCOMPLETE: LinkedIn adds badges without notice, so treat this as
 * a list that will fall behind reality. The chrome check in parseAlertEmail is
 * the backstop for the ones that get through: an unrecognised line that still
 * does not look like a company yields "Unknown" instead of a confident lie.
 */
export const BADGE_LINE_PATTERNS: readonly RegExp[] = [
  /^promoted$/i,
  /^reposted$/i,
  /^new$/i,
  /^viewed$/i,
  /^verified$/i,
  /^easy apply$/i,
  /^actively recruiting$/i,
  /^actively reviewing applicants$/i,
  /^be an early applicant$/i,
  /^alumni work here$/i,
  /^response time is typically .+$/i,
  // "12 connections", "3 alumni work here", "47 applicants", "1,204 people"
  /^\d[\d,.]*\+?\s+(connections?|alumni|applicants?|people)\b.*$/i,
  // "2 days ago", "9 hours ago"
  /^\d+\s+(minutes?|hours?|days?|weeks?|months?)\s+ago$/i,
  /^(today|yesterday)$/i,
];

function isBadgeLine(line: string): boolean {
  const t = line.replace(TRAILING_CHROME_RE, "").trim();
  return BADGE_LINE_PATTERNS.some((re) => re.test(t));
}

// A last-ditch smell test for lines that are chrome we have not enumerated.
// Anything matching this is not a company name and not a location.
const CHROME_HINT_RE =
  /(\bapplicants?\b|\bconnections?\b|\balumni\b|actively (recruiting|reviewing)|easy apply|\bpromoted\b|\breposted\b|\d+\s*(minute|hour|day|week|month)s?\s+ago)/i;

// Company names and locations are short. A long line is a sentence, which
// means the positional assumption has already broken.
const MAX_FIELD_LEN = 80;

/** Returns the line only if it plausibly IS a company/location value. */
function plausibleField(line?: string): string | undefined {
  if (!line) return undefined;
  if (line.length > MAX_FIELD_LEN) return undefined;
  if (CHROME_HINT_RE.test(line)) return undefined;
  return line;
}

// LinkedIn states the work arrangement inside the location line: "London,
// England (Hybrid)", "Austin, TX (Remote)", "Sydney, NSW (On-site)".
const ONSITE_RE = /\b(on[\s-]?site|onsite|hybrid|in[\s-]?office)\b/i;
const REMOTE_RE = /\b(remote|work from home|wfh|anywhere|distributed)\b/i;

/**
 * Work arrangement from the location text.
 *
 * Deliberately tri-state. This used to be hardcoded `true` for every alert
 * job, which handed a remote bonus in lib/domain/scoring/score.ts to on-site
 * roles and told the reader "remote" about a job in a London office. On-site
 * and hybrid are checked first: hybrid requires office presence, so it is not
 * remote. When the location says nothing either way the answer is `undefined`
 * - unknown, scored as neither a bonus nor a penalty - never a guess.
 */
export function inferRemote(location?: string): boolean | undefined {
  if (!location) return undefined;
  if (ONSITE_RE.test(location)) return false;
  if (REMOTE_RE.test(location)) return true;
  return undefined;
}

// Minimal structural type for a DOM node, so we don't take a direct dependency
// on domhandler's types just to walk children.
type DomNode = {
  type: string;
  name?: string;
  data?: string;
  children?: DomNode[];
};

/**
 * Splits an element into logical lines.
 *
 * NOTE: we cannot use `$(el).text().split("\n")` here - HTML email tables put
 * each field in its own <div> with no newline between them, so .text() returns
 * "VercelRemote, Worldwide" as one string and company/location get glued
 * together. Walking text nodes individually keeps them separate. Anchors are
 * taken whole so a title wrapped in nested <span>s isn't shredded.
 */
function lines($: cheerio.CheerioAPI, el: DomNode): string[] {
  const out: string[] = [];
  const push = (s?: string) => {
    const t = (s || "").replace(/\s+/g, " ").trim();
    if (t) out.push(t);
  };
  const walk = (node: DomNode) => {
    if (node.type === "text") return push(node.data);
    if (node.type !== "tag") return;
    if (node.name === "a" || node.name === "img") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return push($(node as any).text());
    }
    for (const c of node.children || []) walk(c);
  };
  walk(el);
  return out;
}

export type Parsed = {
  id: string;
  title: string;
  company: string;
  location?: string;
  /** true remote, false on-site/hybrid, undefined when the email doesn't say. */
  remote?: boolean;
};

/**
 * Pulls jobs out of one LinkedIn alert email.
 *
 * FRAGILE BY NATURE: LinkedIn changes these templates without notice. The job
 * id and URL come from a regex on the href and are stable; title, company and
 * location are positional heuristics. When the heuristics stop fitting, this
 * degrades to "Unknown"/undefined rather than to a confident wrong value -
 * that is what the badge and chrome filters below are protecting.
 *
 * KNOWN ASSUMPTION, not currently defended: fields are read from the nearest
 * enclosing <td>/<tr>/<table>, which assumes one job per cell. A single-column
 * div layout, or a template that puts the title in its own cell, would either
 * lose company/location or read them from the neighbouring job. Detecting a
 * card boundary properly needs a real example of the broken template, so this
 * is documented instead of guessed at.
 */
export function parseAlertEmail(html: string): Parsed[] {
  const $ = cheerio.load(html);
  const byId = new Map<string, Parsed>();

  $("a[href]").each((_i, a) => {
    const href = $(a).attr("href") || "";
    const m = href.match(JOB_URL_RE);
    if (!m) return;
    const id = m[1];

    const text = $(a).text().replace(/\s+/g, " ").trim();
    if (!text || isNavigationText(text)) return;

    // Prefer the richest anchor text seen for this job id - LinkedIn emits
    // several links per job (logo, title, CTA) and only one is the title.
    const existing = byId.get(id);
    if (existing && existing.title.length >= text.length) return;

    // Company/location: walk up to the enclosing row and read the lines that
    // follow the title, skipping the badges LinkedIn sprinkles in between.
    let company = "Unknown";
    let location: string | undefined;
    const container = $(a).closest("td, tr, table").get(0);
    if (container) {
      const ls = lines($, container as unknown as DomNode);
      const idx = ls.findIndex((l) => l === text);
      if (idx >= 0) {
        const after = ls
          .slice(idx + 1)
          .filter((l) => !isNavigationText(l) && !isBadgeLine(l));
        // If the first surviving line still doesn't look like a company, the
        // positional assumption has broken - stop trusting the positions
        // entirely rather than reporting chrome as the employer. "Unknown" is
        // visible in the digest; a wrong company name is not.
        const candidate = plausibleField(after[0]);
        if (candidate) {
          company = candidate;
          location = plausibleField(after[1]);
        }
      }
    }

    byId.set(id, { id, title: text, company, location, remote: inferRemote(location) });
  });

  return [...byId.values()];
}

export async function fetchLinkedInAlerts(): Promise<RawJob[]> {
  const env = getEnv();
  if (!env.ENABLE_LINKEDIN_ALERTS) return [];

  // The config module keeps the IMAP and Gmail keys separate; the fallback -
  // "the app password you already use for sending also works for reading" -
  // is a property of this connector, so it lives here.
  const user = env.IMAP_USER ?? env.GMAIL_USER;
  const pass = env.IMAP_PASSWORD ?? env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error(
      "ENABLE_LINKEDIN_ALERTS=1 but no IMAP credentials. Set IMAP_USER/IMAP_PASSWORD, " +
        "or GMAIL_USER/GMAIL_APP_PASSWORD (the same app password works for IMAP)."
    );
  }

  const { IMAP_HOST: host, IMAP_PORT: port, IMAP_MAILBOX: mailbox } = env;
  const days = env.LINKEDIN_ALERT_DAYS;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  const out: RawJob[] = [];
  const seen = new Set<string>();

  await client.connect();
  try {
    // readOnly so we never mark your mail as read or otherwise mutate the
    // mailbox - this connector observes, it does not touch your inbox.
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      for await (const msg of client.fetch(
        { since, from: "linkedin.com" },
        { source: true }
      )) {
        if (!msg.source) continue;
        const mail = await simpleParser(msg.source);
        const html =
          typeof mail.html === "string"
            ? mail.html
            : mail.textAsHtml || `<pre>${mail.text || ""}</pre>`;

        for (const p of parseAlertEmail(html)) {
          if (seen.has(p.id)) continue;
          seen.add(p.id);
          out.push({
            source: "linkedin_alert",
            sourceId: p.id,
            title: p.title,
            company: p.company,
            // Canonical, tracking-free URL.
            url: `https://www.linkedin.com/jobs/view/${p.id}/`,
            // Never an apply-by-email address, so this can never auto-send.
            applyEmail: undefined,
            location: p.location,
            // Derived from the location text, never assumed. undefined means
            // the email didn't say - scoring treats that as unknown, which is
            // the honest answer for a digest line like "Dublin, Ireland".
            remote: p.remote,
            tags: ["linkedin-alert"],
            // Alert emails carry no description. ./enrich.ts may fill this in
            // later from the public job page; until then the job is scored on
            // its title alone.
            description: undefined,
            sparse: true,
            postedAt: mail.date || undefined,
          });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }

  return out;
}
