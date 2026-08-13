import { and, eq, gte } from "drizzle-orm";
import { getDb, schema } from "./db/client";
import { fetchAllJobs, fetchAllLeads } from "./sources";
import { scoreJob, scoreLead } from "./matcher";
import { generateCoverLetter, generatePitch } from "./drafts";
import { sendMail, sendDigest } from "./mailer";
import { getActiveResume } from "./documents";
import { LINKS } from "./resumeData";

const MATCH_THRESHOLD = 40; // 0-100; below this a job/lead is kept but not drafted
const OUTREACH_DAILY_CAP = Number(process.env.OUTREACH_DAILY_CAP || 10);

// DRY_RUN=1 -> fetch, score, and draft everything into the dashboard, but send
// ZERO email: no applications, no outreach, not even the digest. `sendMode` is
// still recorded as what a live run *would* have done, so the dashboard shows
// you exactly which drafts would have gone out unattended.
// Remove DRY_RUN from the env (or set it to 0) to go live.
const DRY_RUN = process.env.DRY_RUN === "1";

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function runDailyPipeline() {
  const db = getDb();
  const errors: string[] = [];
  let newJobs = 0;
  let newLeads = 0;
  let applicationsAutoSent = 0;
  let applicationsQueued = 0;
  let outreachAutoSent = 0;
  let outreachQueued = 0;

  // ---- 0. Resume ----------------------------------------------------------
  // Fetched once and reused. An application email with no CV attached reads as
  // careless and burns the lead, so with no resume on file we refuse to
  // auto-send anything and queue it for review instead.
  const resume = await getActiveResume();
  if (!resume) {
    errors.push(
      "No resume on file - all applications queued for manual review instead of being sent. " +
        "Upload a PDF at /dashboard/settings."
    );
  }

  // ---- 1. Fetch from all sources -----------------------------------------
  const [{ jobs: rawJobs, errors: jobErrors }, { leads: rawLeads, errors: leadErrors }] =
    await Promise.all([fetchAllJobs(), fetchAllLeads()]);
  errors.push(...jobErrors, ...leadErrors);

  // ---- 2. De-dupe + insert new jobs --------------------------------------
  const newlyInsertedJobs: (typeof schema.jobs.$inferSelect)[] = [];
  for (const raw of rawJobs) {
    const existing = await db
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(and(eq(schema.jobs.source, raw.source), eq(schema.jobs.sourceId, raw.sourceId)))
      .limit(1);
    if (existing.length) continue;

    const { score, reasons } = scoreJob(raw);
    const [inserted] = await db
      .insert(schema.jobs)
      .values({
        source: raw.source,
        sourceId: raw.sourceId,
        title: raw.title,
        company: raw.company,
        companyUrl: raw.companyUrl,
        url: raw.url,
        applyEmail: raw.applyEmail,
        location: raw.location,
        remote: raw.remote ?? true,
        salaryText: raw.salaryText,
        tags: raw.tags || [],
        description: raw.description,
        postedAt: raw.postedAt,
        score,
        scoreReasons: reasons,
        status: score >= MATCH_THRESHOLD ? "matched" : "found",
      })
      .returning();
    newJobs++;
    if (score >= MATCH_THRESHOLD) newlyInsertedJobs.push(inserted);
  }

  // ---- 3. De-dupe + insert new leads --------------------------------------
  const newlyInsertedLeads: (typeof schema.leads.$inferSelect)[] = [];
  for (const raw of rawLeads) {
    const existing = await db
      .select({ id: schema.leads.id })
      .from(schema.leads)
      .where(and(eq(schema.leads.source, raw.source), eq(schema.leads.sourceId, raw.sourceId)))
      .limit(1);
    if (existing.length) continue;

    const { score, reasons } = scoreLead(raw);
    const [inserted] = await db
      .insert(schema.leads)
      .values({
        source: raw.source,
        sourceId: raw.sourceId,
        title: raw.title,
        clientOrCompany: raw.clientOrCompany,
        url: raw.url,
        contactEmail: raw.contactEmail,
        budgetText: raw.budgetText,
        description: raw.description,
        postedAt: raw.postedAt,
        score,
        scoreReasons: reasons,
        status: score >= MATCH_THRESHOLD ? "matched" : "found",
      })
      .returning();
    newLeads++;
    if (score >= MATCH_THRESHOLD) newlyInsertedLeads.push(inserted);
  }

  // ---- 4. Draft + (maybe) auto-send applications for matched jobs --------
  for (const job of newlyInsertedJobs) {
    try {
      const draft = await generateCoverLetter({
        source: job.source,
        sourceId: job.sourceId,
        title: job.title,
        company: job.company,
        companyUrl: job.companyUrl || undefined,
        url: job.url,
        applyEmail: job.applyEmail || undefined,
        location: job.location || undefined,
        remote: job.remote ?? true,
        salaryText: job.salaryText || undefined,
        tags: (job.tags as string[]) || [],
        description: job.description || undefined,
        postedAt: job.postedAt || undefined,
      });

      // No resume => never auto-send, regardless of DRY_RUN.
      const wouldAutoSend = Boolean(job.applyEmail) && Boolean(resume);
      const canAutoSend = wouldAutoSend && !DRY_RUN;
      const [app] = await db
        .insert(schema.applications)
        .values({
          jobId: job.id,
          coverLetter: draft.text,
          emphasizedSkills: draft.emphasizedSkills,
          generatedBy: draft.generatedBy,
          sendMode: wouldAutoSend ? "auto_email" : "manual_portal",
          status: "draft",
        })
        .returning();

      if (canAutoSend && job.applyEmail && resume) {
        const result = await sendMail({
          to: job.applyEmail,
          subject: `Application: ${job.title}`,
          text: draft.text,
          attachments: [
            {
              filename: resume.filename,
              content: resume.buffer,
              contentType: resume.mimeType,
            },
          ],
        });
        if (result.ok) {
          await db
            .update(schema.applications)
            .set({ status: "sent", sentAt: new Date(), sentTo: job.applyEmail })
            .where(eq(schema.applications.id, app.id));
          await db
            .update(schema.jobs)
            .set({ status: "sent", updatedAt: new Date() })
            .where(eq(schema.jobs.id, job.id));
          applicationsAutoSent++;
        } else {
          await db
            .update(schema.applications)
            .set({ status: "failed", error: result.error })
            .where(eq(schema.applications.id, app.id));
          errors.push(`send application for job ${job.id}: ${result.error}`);
          applicationsQueued++;
        }
      } else {
        await db
          .update(schema.applications)
          .set({ status: "ready_for_review" })
          .where(eq(schema.applications.id, app.id));
        await db
          .update(schema.jobs)
          .set({ status: "ready_for_review", updatedAt: new Date() })
          .where(eq(schema.jobs.id, job.id));
        applicationsQueued++;
      }
    } catch (err) {
      errors.push(
        `application draft for job ${job.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ---- 5. Draft + (capped) auto-send outreach for matched leads ---------
  const sentTodayRows = await db
    .select({ id: schema.outreach.id })
    .from(schema.outreach)
    .where(gte(schema.outreach.sentAt, startOfToday()));
  let sentToday = sentTodayRows.length;

  for (const lead of newlyInsertedLeads) {
    try {
      const draft = await generatePitch({
        source: lead.source,
        sourceId: lead.sourceId,
        title: lead.title,
        clientOrCompany: lead.clientOrCompany || undefined,
        url: lead.url,
        contactEmail: lead.contactEmail || undefined,
        budgetText: lead.budgetText || undefined,
        description: lead.description || undefined,
        postedAt: lead.postedAt || undefined,
      });

      const wouldAutoSend =
        Boolean(lead.contactEmail) && sentToday < OUTREACH_DAILY_CAP;
      const canAutoSend = wouldAutoSend && !DRY_RUN;
      const [pitch] = await db
        .insert(schema.outreach)
        .values({
          leadId: lead.id,
          pitch: draft.text,
          generatedBy: draft.generatedBy,
          sendMode: wouldAutoSend ? "auto_email" : "manual",
          status: "draft",
        })
        .returning();

      // Deliberately NO resume attachment on cold outreach: an unsolicited
      // email with a PDF attached scores materially worse with spam filters,
      // and a freelance client wants a portfolio link first, not a CV. The
      // pitch links to the portfolio and Ziro instead.
      if (canAutoSend && lead.contactEmail) {
        const result = await sendMail({
          to: lead.contactEmail,
          subject: `Re: ${lead.title}`,
          text: draft.text,
        });
        if (result.ok) {
          await db
            .update(schema.outreach)
            .set({ status: "sent", sentAt: new Date(), sentTo: lead.contactEmail })
            .where(eq(schema.outreach.id, pitch.id));
          await db
            .update(schema.leads)
            .set({ status: "sent", updatedAt: new Date() })
            .where(eq(schema.leads.id, lead.id));
          outreachAutoSent++;
          sentToday++;
        } else {
          await db
            .update(schema.outreach)
            .set({ status: "failed", error: result.error })
            .where(eq(schema.outreach.id, pitch.id));
          errors.push(`send outreach for lead ${lead.id}: ${result.error}`);
          outreachQueued++;
        }
      } else {
        await db
          .update(schema.outreach)
          .set({ status: "ready_for_review" })
          .where(eq(schema.outreach.id, pitch.id));
        await db
          .update(schema.leads)
          .set({ status: "pitched", updatedAt: new Date() })
          .where(eq(schema.leads.id, lead.id));
        outreachQueued++;
      }
    } catch (err) {
      errors.push(
        `pitch draft for lead ${lead.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ---- 6. Log + digest ----------------------------------------------------
  const summary =
    (DRY_RUN
      ? "*** DRY RUN - no email was sent. Everything below was drafted only. ***\n\n"
      : "") +
    `New jobs: ${newJobs} | New leads: ${newLeads}\n` +
    `Applications auto-sent: ${applicationsAutoSent} | queued for review: ${applicationsQueued}\n` +
    `Outreach auto-sent: ${outreachAutoSent} | queued for review: ${outreachQueued}` +
    (errors.length ? `\n\nErrors (${errors.length}):\n- ${errors.join("\n- ")}` : "");

  await db.insert(schema.digestLogs).values({
    newJobs,
    newLeads,
    applicationsAutoSent,
    applicationsQueued,
    outreachAutoSent,
    outreachQueued,
    errors,
    summary,
  });

  const dashboardUrl = process.env.NEXT_PUBLIC_APP_URL || "";
  if (!DRY_RUN) {
    await sendDigest(
      `Daily job/lead digest - ${newJobs} jobs, ${newLeads} leads`,
      `${summary}\n\n${dashboardUrl ? `Review + approve queued items: ${dashboardUrl}/dashboard\n` : ""}Links on file: LinkedIn ${LINKS.linkedin}, Portfolio ${LINKS.portfolio}, Ziro ${LINKS.ziro}`
    );
  }

  return {
    dryRun: DRY_RUN,
    newJobs,
    newLeads,
    applicationsAutoSent,
    applicationsQueued,
    outreachAutoSent,
    outreachQueued,
    errors,
  };
}
