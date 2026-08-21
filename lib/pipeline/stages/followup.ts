import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";
import { schema } from "@/lib/infra/db/client";
import { sendMail } from "@/lib/infra/mail/send";
import { composeFollowUp } from "@/lib/domain/drafting/compose";
import { getActiveResume } from "@/lib/infra/db/documents";
import { getOwnerUserId } from "@/lib/infra/db/users";
import type { StageContext, StageResult } from "../context";
import { followUpStep, nextFollowUpDue } from "../followup-schedule";

// ---------------------------------------------------------------------------
// Follow-up: one nudge, one final message, then never again.
//
// Runs after `watch`, which clears nextFollowUpAt on anything that got a reply.
// The query below therefore reads "sent, still unanswered, and due".
//
// Every send here goes to a real person who did not ask to be emailed twice, so
// the guards are deliberately conservative: a hard cap on the sequence length, a
// daily cap on volume, DRY_RUN, and a respondedAt check that is re-verified at
// the row level rather than trusted from the batch read.
// ---------------------------------------------------------------------------

export async function runFollowUp(ctx: StageContext): Promise<StageResult> {
  if (!ctx.env.ENABLE_FOLLOWUPS) return { processed: 0, hasMore: false };
  if (ctx.env.DRY_RUN) return { processed: 0, hasMore: false };

  // Unlike dispatch, a follow-up has nothing useful to do without a mailbox.
  // Dispatch can still draft and queue for one-click sending; a follow-up is
  // ONLY a send, so with no sender there is no half-measure — it waits for the
  // next run instead. `nextFollowUpAt` is left untouched, so nothing is skipped
  // permanently: the moment a mailbox is configured, everything due goes out.
  if (!ctx.sender) return { processed: 0, hasMore: false };

  const now = new Date();
  let remaining = ctx.env.FOLLOWUP_DAILY_CAP;
  if (remaining <= 0) return { processed: 0, hasMore: false };

  const [apps, pitches] = await Promise.all([
    ctx.db
      .select()
      .from(schema.applications)
      .where(
        and(
          eq(schema.applications.status, "sent"),
          isNull(schema.applications.respondedAt),
          isNotNull(schema.applications.nextFollowUpAt),
          lte(schema.applications.nextFollowUpAt, now),
          isNotNull(schema.applications.sentTo)
        )
      )
      .limit(remaining),
    ctx.db
      .select()
      .from(schema.outreach)
      .where(
        and(
          eq(schema.outreach.status, "sent"),
          isNull(schema.outreach.respondedAt),
          isNotNull(schema.outreach.nextFollowUpAt),
          lte(schema.outreach.nextFollowUpAt, now),
          isNotNull(schema.outreach.sentTo)
        )
      )
      .limit(remaining),
  ]);

  if (apps.length === 0 && pitches.length === 0) {
    return { processed: 0, hasMore: false };
  }

  // Same stopgap as dispatch: follow-ups belong to the shared unattended queue,
  // so they attach the owner's resume -- the single row this read before
  // accounts existed.
  const ownerId = await getOwnerUserId();
  const resume = ownerId === null ? null : await getActiveResume(ownerId);
  let processed = 0;

  // --- Application follow-ups ---------------------------------------------
  for (const app of apps) {
    if (remaining <= 0) break;
    if (!ctx.deadline.hasBudget(5_000)) break;

    const [job] = await ctx.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, app.jobId))
      .limit(1);
    if (!job) continue;

    // A human may have moved the job on (interview, offer, ignored) since the
    // application was sent. Chasing those would be wrong, and the application
    // row alone does not know about it.
    if (["responded", "interview", "offer", "ignored", "closed"].includes(job.status)) {
      await ctx.db
        .update(schema.applications)
        .set({ nextFollowUpAt: null })
        .where(eq(schema.applications.id, app.id));
      continue;
    }

    const step = followUpStep(app.followUpCount);
    const daysSince = app.sentAt
      ? Math.max(0, Math.round((now.getTime() - app.sentAt.getTime()) / 86_400_000))
      : 0;

    try {
      const followUp = composeFollowUp({
        kind: "application",
        step,
        roleTitle: job.title,
        company: job.company,
        originalSubject: `Application: ${job.title}`,
        daysSince,
      });

      const result = await sendMail({
        from: ctx.sender!,
        to: app.sentTo!,
        subject: followUp.subject,
        text: followUp.text,
        // The CV goes with an application follow-up but never with cold
        // outreach — see the note in the outreach loop below.
        attachments: resume
          ? [
              {
                filename: resume.filename,
                content: resume.buffer,
                contentType: resume.mimeType,
              },
            ]
          : undefined,
      });

      if (!result.ok) {
        ctx.errors.push(`follow-up for application ${app.id}: ${result.error}`);
        continue;
      }

      const count = app.followUpCount + 1;
      await ctx.db
        .update(schema.applications)
        .set({
          followUpCount: count,
          lastFollowUpAt: now,
          // Null once the sequence is exhausted, which is what makes "then
          // never again" a property of the data rather than of the code path.
          nextFollowUpAt: app.sentAt
            ? nextFollowUpDue(count, app.sentAt, ctx.env)
            : null,
        })
        .where(eq(schema.applications.id, app.id));

      remaining--;
      ctx.counters.followUpsSent++;
      processed++;
    } catch (err) {
      ctx.errors.push(
        `follow-up for application ${app.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // --- Outreach follow-ups -------------------------------------------------
  for (const pitch of pitches) {
    if (remaining <= 0) break;
    if (!ctx.deadline.hasBudget(5_000)) break;

    const [lead] = await ctx.db
      .select()
      .from(schema.leads)
      .where(eq(schema.leads.id, pitch.leadId))
      .limit(1);
    if (!lead) continue;

    if (["responded", "won", "lost", "ignored"].includes(lead.status)) {
      await ctx.db
        .update(schema.outreach)
        .set({ nextFollowUpAt: null })
        .where(eq(schema.outreach.id, pitch.id));
      continue;
    }

    const step = followUpStep(pitch.followUpCount);
    const daysSince = pitch.sentAt
      ? Math.max(0, Math.round((now.getTime() - pitch.sentAt.getTime()) / 86_400_000))
      : 0;

    try {
      const followUp = composeFollowUp({
        kind: "outreach",
        step,
        roleTitle: lead.title,
        company: lead.clientOrCompany ?? undefined,
        originalSubject: `Re: ${lead.title}`,
        daysSince,
      });

      // No attachment, deliberately: an unsolicited email with a PDF scores
      // worse with spam filters, and a freelance client wants a portfolio link
      // before a CV. composeFollowUp puts the portfolio link in the body.
      const result = await sendMail({
        from: ctx.sender!,
        to: pitch.sentTo!,
        subject: followUp.subject,
        text: followUp.text,
      });

      if (!result.ok) {
        ctx.errors.push(`follow-up for outreach ${pitch.id}: ${result.error}`);
        continue;
      }

      const count = pitch.followUpCount + 1;
      await ctx.db
        .update(schema.outreach)
        .set({
          followUpCount: count,
          lastFollowUpAt: now,
          nextFollowUpAt: pitch.sentAt
            ? nextFollowUpDue(count, pitch.sentAt, ctx.env)
            : null,
        })
        .where(eq(schema.outreach.id, pitch.id));

      remaining--;
      ctx.counters.followUpsSent++;
      processed++;
    } catch (err) {
      ctx.errors.push(
        `follow-up for outreach ${pitch.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return { processed, hasMore: false };
}
