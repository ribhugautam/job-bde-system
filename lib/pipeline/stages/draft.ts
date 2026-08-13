import { eq } from "drizzle-orm";
import { schema } from "@/lib/infra/db/client";
import {
  generateCoverLetter,
  generatePitch,
} from "@/lib/domain/drafting/compose";
import type { StageContext, StageResult } from "../context";
import { claimJobs, claimLeads, failJob, failLead } from "./claim";

// ---------------------------------------------------------------------------
// Draft: write the cover letter / pitch.
//
// The API key is passed in explicitly rather than read from the environment,
// because compose.ts lives in lib/domain and domain code does not touch env.
// That is not ceremony: it is what lets the drafting tests run the real Claude
// code path against a stub without a key ever being present, and what stops a
// forgotten key in someone's shell silently changing test results.
//
// Note this stage does NOT send anything and does not decide whether it can.
// It only produces text and moves the row to `dispatch`. Keeping "write" and
// "send" as separate stages means a drafting failure can retry without any risk
// of double-sending an email that already went out.
// ---------------------------------------------------------------------------

export async function runDraft(ctx: StageContext): Promise<StageResult> {
  const limit = ctx.env.WORKER_BATCH_SIZE;
  const apiKey = ctx.env.ANTHROPIC_API_KEY;

  const jobs = await claimJobs(ctx, "draft", limit);
  const leads = await claimLeads(ctx, "draft", limit);
  if (jobs.length === 0 && leads.length === 0) {
    return { processed: 0, hasMore: false };
  }

  let processed = 0;

  for (const job of jobs) {
    // Drafting can call out to the Anthropic API, so check the clock per row
    // rather than per batch.
    if (!ctx.deadline.hasBudget(8_000)) break;
    try {
      const draft = await generateCoverLetter(
        {
          source: job.source,
          sourceId: job.sourceId,
          title: job.title,
          company: job.company,
          companyUrl: job.companyUrl ?? undefined,
          url: job.url,
          applyEmail: job.applyEmail ?? undefined,
          location: job.location ?? undefined,
          remote: job.remote ?? true,
          salaryText: job.salaryText ?? undefined,
          tags: (job.tags as string[]) ?? [],
          description: job.description ?? undefined,
          postedAt: job.postedAt ?? undefined,
          sparse: !job.description,
        },
        { apiKey }
      );

      await ctx.db.insert(schema.applications).values({
        jobId: job.id,
        coverLetter: draft.text,
        emphasizedSkills: draft.emphasizedSkills,
        generatedBy: draft.generatedBy,
        // Provisional. The dispatch stage makes the real call, because it also
        // has to know whether a resume is on file.
        sendMode: job.applyEmail ? "auto_email" : "manual_portal",
        status: "draft",
      });

      await ctx.db
        .update(schema.jobs)
        .set({
          stage: "dispatch",
          attempts: 0,
          lastError: null,
          nextAttemptAt: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.jobs.id, job.id));
      processed++;
    } catch (err) {
      await failJob(ctx, job.id, job.attempts, err);
    }
  }

  for (const lead of leads) {
    if (!ctx.deadline.hasBudget(8_000)) break;
    try {
      const draft = await generatePitch(
        {
          source: lead.source,
          sourceId: lead.sourceId,
          title: lead.title,
          clientOrCompany: lead.clientOrCompany ?? undefined,
          url: lead.url,
          contactEmail: lead.contactEmail ?? undefined,
          budgetText: lead.budgetText ?? undefined,
          description: lead.description ?? undefined,
          postedAt: lead.postedAt ?? undefined,
        },
        { apiKey }
      );

      await ctx.db.insert(schema.outreach).values({
        leadId: lead.id,
        pitch: draft.text,
        generatedBy: draft.generatedBy,
        sendMode: lead.contactEmail ? "auto_email" : "manual",
        status: "draft",
      });

      await ctx.db
        .update(schema.leads)
        .set({
          stage: "dispatch",
          attempts: 0,
          lastError: null,
          nextAttemptAt: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.leads.id, lead.id));
      processed++;
    } catch (err) {
      await failLead(ctx, lead.id, lead.attempts, err);
    }
  }

  return {
    processed,
    hasMore: jobs.length === limit || leads.length === limit,
  };
}
