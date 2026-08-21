import { simpleParser } from "mailparser";
import * as cheerio from "cheerio";
import { RawJob } from "../sources/types";
import type { Settings } from "@/lib/config/settings";
import { withMailbox } from "@/lib/infra/mail/imap";
import { deriveArrangement, type WorkArrangement } from "@/lib/domain/facts";

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
//     "(On-site)"), so it is derived from it via deriveArrangement() and left
//     "unknown" when the email doesn't say. It is never assumed.
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

/** LinkedIn separates the title+company half of a card from the location half. */
const CARD_SEPARATOR = " · ";

/**
 * Trailing badges LinkedIn appends after the location.
 *
 * Anchored to the END of the string and stripped repeatedly, because a card
 * carries several ("... (On-site) Actively recruiting Easy Apply"). This is the
 * same enumeration problem as BADGE_LINE_PATTERNS and inherits its caveat: a
 * new badge wording will not be recognised and will remain glued to the
 * location, which degrades to a slightly wrong location rather than to a
 * mangled title.
 */
const TRAILING_BADGE_RES: readonly RegExp[] = [
  /\s+easy apply$/i,
  /\s+actively recruiting$/i,
  /\s+actively reviewing applicants$/i,
  /\s+be an early applicant$/i,
  /\s+fast growing$/i,
  /\s+promoted$/i,
  /\s+reposted$/i,
  /\s+verified$/i,
  /\s+viewed$/i,
  /\s+new$/i,
  /\s+applied on [a-z]{3}\s+\d{1,2}$/i,
  /\s+\d+\s+school alum(?:ni)?$/i,
  /\s+\d[\d,.]*\+?\s+(connections?|alumni|applicants?|people)$/i,
  /\s+\d+\s+(minutes?|hours?|days?|weeks?|months?)\s+ago$/i,
];

const EASY_APPLY_RE = /\beasy apply\b/i;

export type CardParts = {
  /** Title and company, still joined - see splitCard's note. */
  head: string;
  location?: string;
  arrangement: WorkArrangement;
  easyApply: boolean;
};

/**
 * Splits one card's flattened text into its parts.
 *
 * The head is NOT split into title and company here, and cannot be: "SDE II HSV
 * Digital" has no rule that separates the role from the employer without a
 * company list. parseAlertEmail resolves the title from the card's own INNER
 * title anchor when one exists, and otherwise falls back to treating the whole
 * head as the title. repairMangledCard (Task 10) has no anchor available and so
 * leaves the head whole too.
 */
export function splitCard(raw: string): CardParts {
  const easyApply = EASY_APPLY_RE.test(raw);

  let text = raw.replace(/\s+/g, " ").trim();
  // Repeat until stable: a card carries several badges in sequence.
  for (let pass = 0; pass < TRAILING_BADGE_RES.length; pass++) {
    const before = text;
    for (const re of TRAILING_BADGE_RES) text = text.replace(re, "");
    if (text === before) break;
  }

  const at = text.indexOf(CARD_SEPARATOR);
  const head = (at >= 0 ? text.slice(0, at) : text).trim();
  const location = at >= 0 ? text.slice(at + CARD_SEPARATOR.length).trim() : undefined;

  return {
    head,
    location: location || undefined,
    arrangement: deriveArrangement({ location }),
    easyApply,
  };
}

export type Parsed = {
  id: string;
  title: string;
  company: string;
  location?: string;
  arrangement: WorkArrangement;
  easyApply: boolean;
};

/** One anchor's flattened text, still tied to the DOM node it came from. */
type Anchor = { el: unknown; raw: string };

/** The company name from the card's company link, when LinkedIn includes one. */
function companyLinkFromContainer(
  $: cheerio.CheerioAPI,
  container: unknown
): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const linked = $(container as any)
    .find('a[href*="linkedin.com/company/"]')
    .first()
    .text()
    .trim();
  return linked ? linked.replace(/\s+/g, " ") : undefined;
}

/** Removes `prefix` from the start of `head`, case-insensitively. */
function subtractPrefix(head: string, prefix: string): string | undefined {
  if (!prefix) return undefined;
  const h = head.trim();
  const p = prefix.trim();
  if (!h.toLowerCase().startsWith(p.toLowerCase())) return undefined;
  const rest = h.slice(p.length).trim();
  return rest || undefined;
}

/**
 * Parses a card that is carried by a single usable anchor - either because
 * LinkedIn only emitted one, or because none of several anchors for the id
 * contains a CARD_SEPARATOR and so none of them can be read as "the whole
 * card" (see parseAlertEmail's discriminator).
 *
 * This is also the path every hand-written fixture in this test file
 * exercises (digest-multi-job.html, glued-fields.html, duplicate-anchors.html,
 * trapped-titles.html, badge-lines.html, nested-spans-title.html - each file's
 * own header comment says so explicitly). Those were constructed to mirror an
 * ASSUMED template shape before any real alert email had been captured. Only
 * one real email has been captured since then
 * (tests/fixtures/linkedin-alert.html), and it uses the nested-anchor shape
 * the OTHER branch of parseAlertEmail handles - none of the fixtures listed
 * above are known to reflect a template LinkedIn has actually sent. This
 * fallback path is kept anyway, because a single captured sample cannot rule
 * out a second real template any more than it can confirm one: "LinkedIn
 * only ever sends the nested shape" is exactly as unproven as "LinkedIn also
 * sends this older shape". Deleting the fallback on the strength of one
 * sample would trade a known-safe path for an unverified assumption in the
 * other direction, and would revert six passing tests besides.
 *
 * splitCard's head is the title here (no separator to split company off).
 * Company and location, when they exist at all, live in sibling <div>s
 * outside the anchor, so they are read positionally off the enclosing
 * container the same way this module always has - see the caveat on that
 * below.
 */
function parseSingleAnchorCard(
  $: cheerio.CheerioAPI,
  id: string,
  anchor: Anchor
): Parsed {
  const parts = splitCard(anchor.raw);
  const title = parts.head;
  let location = parts.location;
  let easyApply = parts.easyApply;
  let company: string | undefined;

  // KNOWN ASSUMPTION, not currently defended: fields are read from the
  // nearest enclosing <td>/<tr>/<table>, which assumes one job per cell. A
  // single-column div layout, or a template that puts the title in its own
  // cell, would either lose company/location or read them from the
  // neighbouring job. Detecting a card boundary properly needs a real
  // example of the broken template to design against, so this is documented
  // instead of guessed at.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const container = $(anchor.el as any).closest("td, tr, table").get(0);
  if (container) {
    const ls = lines($, container as unknown as DomNode);
    if (ls.some((l) => EASY_APPLY_RE.test(l))) easyApply = true;

    const idx = ls.findIndex((l) => l === anchor.raw);
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
        location = location ?? plausibleField(after[1]);
      }
    }
  }

  return {
    id,
    title,
    company: company ?? "Unknown",
    location,
    arrangement: deriveArrangement({ location }),
    easyApply,
  };
}

/**
 * Pulls jobs out of one LinkedIn alert email.
 *
 * FRAGILE BY NATURE: LinkedIn changes these templates without notice. The job
 * id and URL come from a regex on the href and are stable; everything else is
 * a positional heuristic. When the heuristics stop fitting, this degrades to
 * "Unknown"/undefined rather than to a confident wrong value - that is what
 * the badge and chrome filters below are protecting.
 *
 * LinkedIn's current digest template nests THREE anchors under one job id: a
 * company-logo anchor (empty text), an OUTER anchor whose text is the WHOLE
 * flattened card (title, company, location, badges - cheerio does not
 * auto-close nested <a> tags, so this text really does contain all of it),
 * and an INNER anchor nested inside the outer one whose text is just the
 * title. Naively keeping "the longest anchor text" as the title - the
 * original bug - deterministically picks that outer whole-card string.
 * Instead: group every anchor by job id first, then read the LONGEST text (it
 * is the one carrying the CARD_SEPARATOR) as the card, and the SHORTEST as the
 * title. When no candidate anchor for an id carries the CARD_SEPARATOR, there
 * is no card vs. title distinction to make, so splitCard's head is used as
 * the title and company/location are read positionally instead - see
 * parseSingleAnchorCard's comment for exactly what is, and is not, known
 * about why that path still exists and what it costs.
 */
export function parseAlertEmail(html: string): Parsed[] {
  const $ = cheerio.load(html);
  const byId = new Map<string, Anchor[]>();

  $("a[href]").each((_i, a) => {
    const href = $(a).attr("href") || "";
    const m = href.match(JOB_URL_RE);
    if (!m) return;
    const id = m[1];
    const raw = $(a).text().replace(/\s+/g, " ").trim();
    const list = byId.get(id);
    if (list) list.push({ el: a, raw });
    else byId.set(id, [{ el: a, raw }]);
  });

  const out: Parsed[] = [];

  for (const [id, anchors] of byId) {
    const candidates = anchors.filter((c) => c.raw && !isNavigationText(c.raw));
    if (candidates.length === 0) continue;

    if (candidates.length === 1) {
      out.push(parseSingleAnchorCard($, id, candidates[0]));
      continue;
    }

    const hasJoinedCard = candidates.some((c) => c.raw.includes(CARD_SEPARATOR));
    if (!hasJoinedCard) {
      // None of this id's anchors carries the CARD_SEPARATOR, so none of
      // them can be read as "the whole card" the way the branch below reads
      // one. That is all this check knows for certain - it does NOT know
      // that this id came from a genuinely different, older LinkedIn
      // template; it only knows the joined-card signal is absent (see
      // parseSingleAnchorCard's comment for what evidence does, and does
      // not, back that reading).
      //
      // KNOWN GAP: a real nested-template card that happens to have no
      // "Company · Location" paragraph at all (so no anchor contains
      // CARD_SEPARATOR) lands here too, indistinguishable from the older
      // shape by this check. If its outer anchor's text then carries a
      // trailing token TRAILING_BADGE_RES does not recognise (a salary
      // range, say), "keep the richest surviving text" glues that token
      // onto the title - a narrower replay of the original bug, pinned by
      // the "known gap" test in alerts.test.ts rather than silently
      // shipped. Company still resolves to "Unknown" in that case (never a
      // wrong guess); only the title gets untidy.
      const best = candidates.reduce((a, b) => (b.raw.length > a.raw.length ? b : a));
      out.push(parseSingleAnchorCard($, id, best));
      continue;
    }

    const card = candidates.reduce((a, b) => (b.raw.length > a.raw.length ? b : a));
    const title = candidates.reduce((a, b) => (b.raw.length < a.raw.length ? b : a));
    const parts = splitCard(card.raw);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const container = $(card.el as any).closest("tr, table").get(0);
    const companyLink = container ? companyLinkFromContainer($, container) : undefined;
    // LinkedIn writes the card as "<Title><Company>" with nothing between
    // them, so once the (known) title is subtracted off the head, whatever
    // remains is the company.
    const company = companyLink ?? subtractPrefix(parts.head, title.raw) ?? "Unknown";

    out.push({
      id,
      title: title.raw,
      company,
      location: parts.location,
      arrangement: parts.arrangement,
      easyApply: parts.easyApply,
    });
  }

  return out;
}

/**
 * Recovers what can be recovered from a title mangled by the previous parser.
 *
 * 107 rows in production stored an entire job card as their title — see the
 * note on parseAlertEmail. That string still contains the location, the work
 * arrangement and the Easy Apply badge, so the facts are recoverable without
 * going back to the mailbox (which no longer holds emails that old).
 *
 * What is NOT recoverable is the title/company split: the company anchor lived
 * in the HTML, not in this text, and "SDE II HSV Digital" cannot be divided by
 * rule. `title` is therefore returned as the badge-stripped head, still
 * containing the company name, and callers should leave `company` as "Unknown"
 * rather than invent one. lib/infra/linkedin/enrich.ts closes that gap from the
 * public job page's JSON-LD.
 */
export function repairMangledCard(storedTitle: string): {
  title: string;
  location?: string;
  arrangement: WorkArrangement;
  easyApply: boolean;
} {
  const parts = splitCard(storedTitle || "");
  return {
    title: parts.head,
    location: parts.location,
    arrangement: parts.arrangement,
    easyApply: parts.easyApply,
  };
}

export async function fetchLinkedInAlerts(settings: Settings): Promise<RawJob[]> {
  if (!settings.ENABLE_LINKEDIN_ALERTS) return [];

  const since = new Date(
    Date.now() - settings.LINKEDIN_ALERT_DAYS * 24 * 60 * 60 * 1000
  );
  const out: RawJob[] = [];
  const seen = new Set<string>();

  await withMailbox(settings, async (client) => {
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
          arrangement: p.arrangement,
          easyApply: p.easyApply,
          // Derived from the location text, never assumed. undefined means
          // the email didn't say - scoring treats that as unknown, which is
          // the honest answer for a digest line like "Dublin, Ireland".
          remote:
            p.arrangement === "unknown" ? undefined : p.arrangement === "remote",
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
  });

  return out;
}
