import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { schema } from "@/lib/infra/db/client";
import { sendMail } from "@/lib/infra/mail/send";
import { getActiveResume } from "@/lib/infra/db/documents";
import { getOwnerUserId } from "@/lib/infra/db/users";
import type { StageContext, StageResult } from "../context";
import { claimJobs, claimLeads, failJob, failLead } from "./claim";
import { nextFollowUpDue } from "../followup-schedule";

// ---------------------------------------------------------------------------
// Dispatch: send what can safely be sent, queue the rest for one keystroke.
//
// Every gate here is a refusal to send, and each exists for a reason:
//
//   no applyEmail   -> the listing never published an address. We do not guess
//                      or infer one. Queued for the apply queue instead.
//   no resume       -> an application email with no CV attached reads as
//                      careless and burns the lead. Better queued than sent bad.
//   DRY_RUN         -> the master switch. Drafts everything, sends nothing.
//   outreach cap    -> cold pitches are rate-limited per day; applications are
//                      not, because a reply to an advertised address is invited
//                      and a cold pitch is not.
// ---------------------------------------------------------------------------

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function runDispatch(ctx: StageContext): Promise<StageResult> {
  const limit = ctx.config.WORKER_BATCH_SIZE;
  const jobs = await claimJobs(ctx, "dispatch", limit);
  const leads = await claimLeads(ctx, "dispatch", limit);
  if (jobs.length === 0 && leads.length === 0) {
    return { processed: 0, hasMore: false };
  }

  // The unattended pipeline still runs one shared queue rather than one per
  // person, so it uses the owner's resume -- the same single row it read before
  // accounts existed. Per-user drafting is what makes this per-user.
  const ownerId = await getOwnerUserId();
  const resume = ownerId === null ? null : await getActiveResume(ownerId);
  if (!resume && jobs.length > 0) {
    // A notice, not an error: nothing broke, and queueing rather than sending
    // without a CV is the correct behavior. It is still the single most
    // valuable thing to act on, so the digest lists it first among notices.
    ctx.notices.push(
      "No resume on file - applications are being queued for review instead of " +
        "sent. Upload a PDF at /dashboard/resume to enable auto-send."
    );
  }

  let processed = 0;
  processed += await dispatchJobs(ctx, jobs, resume);
  processed += await dispatchLeads(ctx, leads);

  return {
    processed,
    hasMore: jobs.length === limit || leads.length === limit,
  };
}

type Resume = Awaited<ReturnType<typeof getActiveResume>>;

async function dispatchJobs(
  ctx: StageContext,
  jobs: Awaited<ReturnType<typeof claimJobs>>,
  resume: Resume
): Promise<number> {
  if (jobs.length === 0) return 0;

  // One query for every application rather than one per job.
  const apps = await ctx.db
    .select()
    .from(schema.applications)
    .where(
      inArray(
        schema.applications.jobId,
        jobs.map((j) => j.id)
      )
    )
    .orderBy(desc(schema.applications.id));

  const latestByJob = new Map<number, (typeof apps)[number]>();
  for (const app of apps) if (!latestByJob.has(app.jobId)) latestByJob.set(app.jobId, app);

  let processed = 0;

  for (const job of jobs) {
    if (!ctx.deadline.hasBudget(6_000)) break;
    const app = latestByJob.get(job.id);

    // Reaching dispatch with no draft means the draft stage advanced the row
    // without inserting. Send it back rather than silently finishing it.
    if (!app) {
      await ctx.db
        .update(schema.jobs)
        .set({ stage: "draft", updatedAt: new Date() })
        .where(eq(schema.jobs.id, job.id));
      ctx.errors.push(`job ${job.id}: reached dispatch with no draft, re-queued`);
      continue;
    }

    try {
      // ctx.sender is the new gate alongside applyEmail and resume: with no
      // usable mailbox there is no address this could honestly come from.
      const canSend =
        Boolean(job.applyEmail) && Boolean(resume) && Boolean(ctx.sender);
      const willSend = canSend && !ctx.config.dryRun;

      if (!willSend) {
        await ctx.db
          .update(schema.applications)
          .set({
            status: "ready_for_review",
            // Recorded as what a LIVE run would have done, so the dashboard
            // shows exactly which drafts would have gone out unattended.
            sendMode: canSend ? "auto_email" : "manual_portal",
          })
          .where(eq(schema.applications.id, app.id));
        await ctx.db
          .update(schema.jobs)
          .set({
            status: "ready_for_review",
            stage: "done",
            attempts: 0,
            lastError: null,
            nextAttemptAt: null,
            updatedAt: new Date(),
          })
          .where(eq(schema.jobs.id, job.id));
        ctx.counters.applicationsQueued++;
        processed++;
        continue;
      }

      const result = await sendMail({
        from: ctx.sender!,
        to: job.applyEmail!,
        subject: `Application: ${job.title}`,
        text: app.coverLetter,
        attachments: [
          {
            filename: resume!.filename,
            content: resume!.buffer,
            contentType: resume!.mimeType,
          },
        ],
      });

      if (!result.ok) {
        await ctx.db
          .update(schema.applications)
          .set({ status: "failed", error: result.error })
          .where(eq(schema.applications.id, app.id));
        // A send failure is worth retrying — the mail server may simply be
        // briefly unavailable — so route it through the backoff rather than
        // marking the job done.
        await failJob(ctx, job.id, job.attempts, new Error(result.error));
        ctx.counters.applicationsQueued++;
        continue;
      }

      const sentAt = new Date();
      if (!result.messageId) {
        // Without an anchor the reply matcher can only fall back to the sender
        // address, which is materially weaker. Surface it rather than let the
        // thread quietly become unmatchable.
        ctx.errors.push(
          `job ${job.id}: sent but no Message-ID was returned; reply detection ` +
            `for this thread will rely on the sender address only`
        );
      }

      await ctx.db
        .update(schema.applications)
        .set({
          status: "sent",
          sentAt,
          sentTo: job.applyEmail,
          sendMode: "auto_email",
          messageId: result.messageId,
          nextFollowUpAt: nextFollowUpDue(0, sentAt, ctx.config),
        })
        .where(eq(schema.applications.id, app.id));

      await ctx.db
        .update(schema.jobs)
        .set({
          status: "sent",
          stage: "done",
          attempts: 0,
          lastError: null,
          nextAttemptAt: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.jobs.id, job.id));

      ctx.counters.applicationsAutoSent++;
      processed++;
    } catch (err) {
      await failJob(ctx, job.id, job.attempts, err);
    }
  }

  return processed;
}

async function dispatchLeads(
  ctx: StageContext,
  leads: Awaited<ReturnType<typeof claimLeads>>
): Promise<number> {
  if (leads.length === 0) return 0;

  const pitches = await ctx.db
    .select()
    .from(schema.outreach)
    .where(
      inArray(
        schema.outreach.leadId,
        leads.map((l) => l.id)
      )
    )
    .orderBy(desc(schema.outreach.id));

  const latestByLead = new Map<number, (typeof pitches)[number]>();
  for (const p of pitches) if (!latestByLead.has(p.leadId)) latestByLead.set(p.leadId, p);

  // The cap counts everything already sent today, including from earlier runs,
  // so splitting one day across several invocations cannot multiply the limit.
  const sentToday = await ctx.db
    .select({ id: schema.outreach.id })
    .from(schema.outreach)
    .where(
      and(
        gte(schema.outreach.sentAt, startOfToday()),
        eq(schema.outreach.status, "sent")
      )
    );
  let remaining = Math.max(0, ctx.config.OUTREACH_DAILY_CAP - sentToday.length);

  let processed = 0;

  for (const lead of leads) {
    if (!ctx.deadline.hasBudget(6_000)) break;
    const pitch = latestByLead.get(lead.id);

    if (!pitch) {
      await ctx.db
        .update(schema.leads)
        .set({ stage: "draft", updatedAt: new Date() })
        .where(eq(schema.leads.id, lead.id));
      ctx.errors.push(`lead ${lead.id}: reached dispatch with no pitch, re-queued`);
      continue;
    }

    try {
      const canSend =
        Boolean(lead.contactEmail) && remaining > 0 && Boolean(ctx.sender);
      const willSend = canSend && !ctx.config.dryRun;

      if (!willSend) {
        await ctx.db
          .update(schema.outreach)
          .set({
            status: "ready_for_review",
            sendMode: canSend ? "auto_email" : "manual",
          })
          .where(eq(schema.outreach.id, pitch.id));
        await ctx.db
          .update(schema.leads)
          .set({
            status: "ready_for_review",
            // Hitting the daily cap is not a permanent state. Leave the row in
            // dispatch so tomorrow's run can still send it, rather than
            // stranding it as done and never pitching at all.
            stage: lead.contactEmail && remaining <= 0 ? "dispatch" : "done",
            nextAttemptAt: null,
            updatedAt: new Date(),
          })
          .where(eq(schema.leads.id, lead.id));
        ctx.counters.outreachQueued++;
        processed++;
        continue;
      }

      // Deliberately NO resume attachment on cold outreach: an unsolicited
      // email with a PDF attached scores materially worse with spam filters,
      // and a freelance client wants a portfolio link first, not a CV.
      const result = await sendMail({
        from: ctx.sender!,
        to: lead.contactEmail!,
        subject: `Re: ${lead.title}`,
        text: pitch.pitch,
      });

      if (!result.ok) {
        await ctx.db
          .update(schema.outreach)
          .set({ status: "failed", error: result.error })
          .where(eq(schema.outreach.id, pitch.id));
        await failLead(ctx, lead.id, lead.attempts, new Error(result.error));
        ctx.counters.outreachQueued++;
        continue;
      }

      const sentAt = new Date();
      await ctx.db
        .update(schema.outreach)
        .set({
          status: "sent",
          sentAt,
          sentTo: lead.contactEmail,
          sendMode: "auto_email",
          messageId: result.messageId,
          nextFollowUpAt: nextFollowUpDue(0, sentAt, ctx.config),
        })
        .where(eq(schema.outreach.id, pitch.id));

      await ctx.db
        .update(schema.leads)
        .set({
          status: "sent",
          stage: "done",
          attempts: 0,
          lastError: null,
          nextAttemptAt: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.leads.id, lead.id));

      remaining--;
      ctx.counters.outreachAutoSent++;
      processed++;
    } catch (err) {
      await failLead(ctx, lead.id, lead.attempts, err);
    }
  }

  return processed;
}
