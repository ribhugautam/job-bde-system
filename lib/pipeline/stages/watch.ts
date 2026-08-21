import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { schema } from "@/lib/infra/db/client";
import {
  fetchInboundSince,
  matchReplies,
  type SentRef,
} from "@/lib/infra/mail/replies";
import type { StageContext, StageResult } from "../context";

// ---------------------------------------------------------------------------
// Watch: find replies and stop chasing people who have answered.
//
// This runs BEFORE the follow-up stage on every invocation, and the ordering is
// load-bearing. Reversed, the system would email a nudge to someone whose reply
// was already sitting in the inbox — the single most embarrassing thing an
// unattended outreach system can do.
//
// Matching is by RFC 5322 Message-ID captured at send time, not by guessing
// from the sender. See lib/infra/mail/replies.ts for the priority rules.
// ---------------------------------------------------------------------------

/**
 * How far back to scan. Comfortably wider than any plausible cron gap, because
 * a missed window means a reply is never seen at all and the follow-up
 * sequence runs to completion against someone who already answered. Re-reading
 * a message that was already matched is free — the row is skipped because it
 * is no longer in the unanswered set.
 */
const LOOKBACK_DAYS = 14;

export async function runWatch(ctx: StageContext): Promise<StageResult> {
  // Reply detection depends on the same IMAP credentials as the alert reader.
  // With none configured there is nothing to scan and no reason to warn on
  // every run — this is an optional capability, not a broken one.
  const hasImap = Boolean(
    (ctx.config.IMAP_USER ?? ctx.config.GMAIL_USER) &&
      (ctx.config.IMAP_PASSWORD ?? ctx.config.GMAIL_APP_PASSWORD)
  );
  if (!hasImap) return { processed: 0, hasMore: false };

  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  // Only threads that are sent and not yet answered. An already-answered thread
  // cannot be answered again, and including it would let a later message in the
  // same thread rewrite respondedAt.
  const [apps, pitches] = await Promise.all([
    ctx.db
      .select({
        id: schema.applications.id,
        messageId: schema.applications.messageId,
        sentTo: schema.applications.sentTo,
        jobId: schema.applications.jobId,
      })
      .from(schema.applications)
      .where(
        and(
          eq(schema.applications.status, "sent"),
          isNull(schema.applications.respondedAt),
          isNotNull(schema.applications.sentAt)
        )
      ),
    ctx.db
      .select({
        id: schema.outreach.id,
        messageId: schema.outreach.messageId,
        sentTo: schema.outreach.sentTo,
        leadId: schema.outreach.leadId,
      })
      .from(schema.outreach)
      .where(
        and(
          eq(schema.outreach.status, "sent"),
          isNull(schema.outreach.respondedAt),
          isNotNull(schema.outreach.sentAt)
        )
      ),
  ]);

  if (apps.length === 0 && pitches.length === 0) {
    return { processed: 0, hasMore: false };
  }

  const refs: SentRef[] = [
    ...apps.map((a) => ({
      kind: "application" as const,
      id: a.id,
      messageId: a.messageId ?? "",
      sentTo: a.sentTo ?? undefined,
    })),
    ...pitches.map((p) => ({
      kind: "outreach" as const,
      id: p.id,
      messageId: p.messageId ?? "",
      sentTo: p.sentTo ?? undefined,
    })),
  ];

  const jobIdByApp = new Map(apps.map((a) => [a.id, a.jobId]));
  const leadIdByOutreachId = new Map(pitches.map((p) => [p.id, p.leadId]));

  let inbound;
  try {
    inbound = await fetchInboundSince(since, ctx.config);
  } catch (err) {
    // A mailbox that will not open must not take the run down — drafting and
    // sending are still useful without reply detection.
    ctx.errors.push(
      `watch: could not read mailbox - ${err instanceof Error ? err.message : String(err)}`
    );
    return { processed: 0, hasMore: false };
  }

  const matches = matchReplies(refs, inbound);

  // One thread can receive several messages; the first match closes it and the
  // rest are redundant.
  const closed = new Set<string>();
  let processed = 0;

  for (const match of matches) {
    const key = `${match.ref.kind}:${match.ref.id}`;
    if (closed.has(key)) continue;
    closed.add(key);

    const respondedAt = match.inbound.date ?? new Date();

    try {
      if (match.ref.kind === "application") {
        await ctx.db
          .update(schema.applications)
          .set({
            status: "responded",
            respondedAt,
            // Cancels the sequence. This single field is the whole reason the
            // watch stage exists.
            nextFollowUpAt: null,
          })
          .where(eq(schema.applications.id, match.ref.id));

        const jobId = jobIdByApp.get(match.ref.id);
        if (jobId !== undefined) {
          await ctx.db
            .update(schema.jobs)
            .set({ status: "responded", updatedAt: new Date() })
            .where(eq(schema.jobs.id, jobId));
        }
      } else {
        await ctx.db
          .update(schema.outreach)
          .set({ status: "responded", respondedAt, nextFollowUpAt: null })
          .where(eq(schema.outreach.id, match.ref.id));

        const leadId = leadIdByOutreachId.get(match.ref.id);
        if (leadId !== undefined) {
          await ctx.db
            .update(schema.leads)
            .set({ status: "responded", updatedAt: new Date() })
            .where(eq(schema.leads.id, leadId));
        }
      }

      // A sender-only match is the weak rule — worth recording so a wrong
      // attribution can be traced rather than silently trusted.
      if (match.matchedBy === "sender") {
        ctx.errors.push(
          `watch: ${match.ref.kind} ${match.ref.id} matched a reply by sender ` +
            `address only (no Message-ID match) - verify before trusting`
        );
      }

      ctx.counters.repliesDetected++;
      processed++;
    } catch (err) {
      ctx.errors.push(
        `watch: failed to record reply for ${match.ref.kind} ${match.ref.id} - ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return { processed, hasMore: false };
}
