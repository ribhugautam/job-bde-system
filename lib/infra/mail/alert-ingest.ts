import { simpleParser } from "mailparser";
import { withMailbox } from "./imap";
import type { AlertSource, ParsedAlertJob } from "@/lib/infra/sources/email/types";
import type { RawJob } from "@/lib/domain/types";

// ---------------------------------------------------------------------------
// Runs ONE email-alert source: mailbox -> messages from that sender -> parser
// -> RawJob[].
//
// Deliberately one source per call, not a batch over all of them. Sharing a
// single connection across sources would mean memoizing the fetch, because
// lib/infra/sources/index.ts runs sources through Promise.all — and that memo
// would live at module scope, where Vercel's lambda reuse would let it outlive
// the run and serve stale jobs on the next one. Three narrow connections once a
// day is the cheaper trade.
//
// The IMAP search is server-side: `{ since, from }` becomes an IMAP SEARCH, so
// only this sender's mail crosses the wire — not the whole mailbox.
// ---------------------------------------------------------------------------

/**
 * The pure half: parsed jobs -> RawJob rows. Exported so it can be tested
 * without a mailbox, the same way factsToRow is in lib/pipeline/stages/ingest.ts.
 */
export function toRawJobs(source: AlertSource, parsed: ParsedAlertJob[]): RawJob[] {
  const out: RawJob[] = [];
  const seen = new Set<string>();

  for (const p of parsed) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);

    out.push({
      source: source.name,
      sourceId: p.id,
      title: p.title,
      company: p.company,
      url: p.url,
      // Alert digests never publish an apply-by-email address, so these can
      // never auto-send. They land in the manual apply queue.
      applyEmail: undefined,
      location: p.location,
      arrangement: p.arrangement,
      easyApply: p.easyApply,
      // Honest tri-state: undefined means the digest did not say. Never coerce
      // to true — that defaulting is the bug Phase 1 existed to remove.
      remote:
        p.arrangement === undefined || p.arrangement === "unknown"
          ? undefined
          : p.arrangement === "remote",
      minYears: p.minYears,
      salaryText: p.salaryText,
      description: p.description,
      tags: source.tags,
      // A digest without a snippet is scored on its title alone; enrichment may
      // recover more later.
      sparse: !p.description,
    });
  }

  return out;
}

/**
 * Fetches and parses every recent alert email from one source.
 *
 * Never throws for a single bad message: one unparseable email skips that
 * message rather than losing the rest of the run.
 */
export async function fetchAlertSource(source: AlertSource): Promise<RawJob[]> {
  const since = new Date(Date.now() - source.days * 24 * 60 * 60 * 1000);

  const parsed = await withMailbox(async (client) => {
    const collected: ParsedAlertJob[] = [];

    for await (const msg of client.fetch(
      { since, from: source.fromDomain },
      { source: true }
    )) {
      if (!msg.source) continue;
      try {
        const mail = await simpleParser(msg.source);
        if (source.subjectFilter && !source.subjectFilter(mail.subject ?? "")) {
          continue;
        }
        const html =
          typeof mail.html === "string"
            ? mail.html
            : mail.textAsHtml || `<pre>${mail.text || ""}</pre>`;
        collected.push(...source.parse(html));
      } catch {
        // A single malformed message must not cost the rest of the digest.
        continue;
      }
    }

    return collected;
  });

  return toRawJobs(source, parsed);
}
