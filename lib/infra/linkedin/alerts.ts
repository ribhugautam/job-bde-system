import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import * as cheerio from "cheerio";
import { RawJob } from "./types";

// ---------------------------------------------------------------------------
// LinkedIn job alerts, read out of your OWN Gmail over IMAP.
//
// This deliberately does NOT touch LinkedIn. LinkedIn has no public jobs API,
// and its User Agreement prohibits scraping and automated access - doing that
// risks the account this whole system points recruiters at. What it does
// instead: you create saved searches on LinkedIn and switch on email alerts;
// those emails arrive in your mailbox, which is your own data, and we parse
// them there.
//
// Consequences of that choice, stated plainly:
//   - Alert emails carry a title, company, location and link. They do NOT
//     carry the job description, so these jobs are flagged `sparse` and are
//     scored/thresholded differently (see lib/matcher.ts and lib/pipeline.ts).
//   - There is no apply-by-email address, so these NEVER auto-send. They land
//     in the dashboard scored, with a drafted cover letter, for you to apply.
//
// SETUP:
//   1. On LinkedIn, run a job search you like -> toggle "Job alert" on ->
//      set delivery to Email, daily.
//   2. Set ENABLE_LINKEDIN_ALERTS=1. IMAP_USER/IMAP_PASSWORD default to
//      GMAIL_USER/GMAIL_APP_PASSWORD - the same app password already used for
//      sending also works for IMAP.
// ---------------------------------------------------------------------------

const JOB_URL_RE = /linkedin\.com\/(?:comm\/)?jobs\/view\/(\d+)/i;

// Anchor text that is navigation, not a job title.
const CTA_RE =
  /^(see all|view all|view job|apply|unsubscribe|manage|settings|help|linkedin|see more|show more|\d+ new jobs?)/i;

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
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

type Parsed = { id: string; title: string; company: string; location?: string };

/**
 * Pulls jobs out of one LinkedIn alert email.
 *
 * FRAGILE BY NATURE: LinkedIn changes these templates without notice. The job
 * id and URL come from a regex on the href and are stable; title and company
 * are positional heuristics and can degrade to "Unknown". If that starts
 * happening the digest will show it, because company shows as Unknown rather
 * than the row silently disappearing.
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
    if (!text || CTA_RE.test(text)) return;

    // Prefer the richest anchor text seen for this job id - LinkedIn emits
    // several links per job (logo, title, CTA) and only one is the title.
    const existing = byId.get(id);
    if (existing && existing.title.length >= text.length) return;

    // Company/location: walk up to the enclosing row and read the lines that
    // follow the title.
    let company = "Unknown";
    let location: string | undefined;
    const container = $(a).closest("td, tr, table").get(0);
    if (container) {
      const ls = lines($, container as unknown as DomNode);
      const idx = ls.findIndex((l) => l === text);
      if (idx >= 0) {
        const after = ls.slice(idx + 1).filter((l) => !CTA_RE.test(l));
        if (after[0]) company = after[0];
        if (after[1]) location = after[1];
      }
    }

    byId.set(id, { id, title: text, company, location });
  });

  return [...byId.values()];
}

export async function fetchLinkedInAlerts(): Promise<RawJob[]> {
  if (env("ENABLE_LINKEDIN_ALERTS") !== "1") return [];

  const user = env("IMAP_USER", env("GMAIL_USER"));
  const pass = env("IMAP_PASSWORD", env("GMAIL_APP_PASSWORD"));
  if (!user || !pass) {
    throw new Error(
      "ENABLE_LINKEDIN_ALERTS=1 but no IMAP credentials. Set IMAP_USER/IMAP_PASSWORD, " +
        "or GMAIL_USER/GMAIL_APP_PASSWORD (the same app password works for IMAP)."
    );
  }

  const host = env("IMAP_HOST", "imap.gmail.com")!;
  const port = Number(env("IMAP_PORT", "993"));
  const days = Number(env("LINKEDIN_ALERT_DAYS", "3"));
  const mailbox = env("IMAP_MAILBOX", "INBOX")!;
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
            remote: true,
            tags: ["linkedin-alert"],
            // No description in alert emails - see `sparse` below.
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
