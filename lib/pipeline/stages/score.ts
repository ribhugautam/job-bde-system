import { eq } from "drizzle-orm";
import { schema } from "@/lib/infra/db/client";
import { scoreJob, scoreLead } from "@/lib/domain/scoring/score";
import type { StageContext, StageResult } from "../context";
import { claimJobs, claimLeads, failJob, failLead } from "./claim";

// ---------------------------------------------------------------------------
// Score: judge each row against the resume and decide whether it is worth
// drafting for.
//
// Note there is no separate threshold for description-less rows any more. The
// old SPARSE_MATCH_THRESHOLD existed because LinkedIn alert emails carry only a
// title, so those jobs could never clear the normal bar and a second, lower one
// was calibrated for them. The enrich stage now recovers the description before
// this stage sees the row, so every job is judged on comparable evidence
// against a single threshold.
//
// A row that reaches here still marked `sparse` is one enrichment genuinely
// could not recover. It is scored on its title honestly and will usually fall
// below the bar — which is the correct outcome, not a regression: there is no
// evidence to justify drafting for it.
// ---------------------------------------------------------------------------

export async function runScore(ctx: StageContext): Promise<StageResult> {
  const limit = ctx.env.WORKER_BATCH_SIZE;
  const threshold = ctx.env.MATCH_THRESHOLD;

  const jobs = await claimJobs(ctx, "score", limit);
  const leads = await claimLeads(ctx, "score", limit);
  if (jobs.length === 0 && leads.length === 0) {
    return { processed: 0, hasMore: false };
  }

  let processed = 0;

  for (const job of jobs) {
    try {
      const { score, reasons } = scoreJob({
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
        // Honest to the end: a row with no description is scored as sparse
        // regardless of why, so the reasons shown in the dashboard say what the
        // number was actually computed from.
        sparse: !job.description,
      });

      const matched = score >= threshold;
      await ctx.db
        .update(schema.jobs)
        .set({
          score,
          scoreReasons: reasons,
          status: matched ? "matched" : "rejected",
          // A rejected row is finished: nothing downstream should draft or send
          // for it, and claim.ts will not pick it up again.
          stage: matched ? "draft" : "done",
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
    try {
      const { score, reasons } = scoreLead({
        source: lead.source,
        sourceId: lead.sourceId,
        title: lead.title,
        clientOrCompany: lead.clientOrCompany ?? undefined,
        url: lead.url,
        contactEmail: lead.contactEmail ?? undefined,
        budgetText: lead.budgetText ?? undefined,
        description: lead.description ?? undefined,
        postedAt: lead.postedAt ?? undefined,
      });

      const matched = score >= threshold;
      await ctx.db
        .update(schema.leads)
        .set({
          score,
          scoreReasons: reasons,
          status: matched ? "matched" : "rejected",
          stage: matched ? "draft" : "done",
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
