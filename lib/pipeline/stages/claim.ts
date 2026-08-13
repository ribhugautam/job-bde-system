import { and, asc, eq, isNull, lte, notInArray, or } from "drizzle-orm";
import { schema } from "@/lib/infra/db/client";
import type { StageContext } from "../context";
import {
  MAX_ATTEMPTS,
  hasAttemptsLeft,
  nextAttemptAt,
  type JobStage,
  type LeadStage,
} from "../state";

// ---------------------------------------------------------------------------
// Selecting the rows a stage should work on.
//
// There is no row locking here, deliberately: exactly one cron fires this
// worker, and adding advisory locks over a stateless HTTP driver would buy
// nothing but latency. What DOES protect against overlap is that every stage
// advances a row's `stage` as its last act, so a second worker arriving late
// finds nothing to claim rather than doing the work twice.
// ---------------------------------------------------------------------------

/** Statuses a human or an earlier stage has closed. Never reopen these. */
const CLOSED_JOB_STATUSES = ["ignored", "rejected", "closed"];
const CLOSED_LEAD_STATUSES = ["ignored", "rejected", "won", "lost"];

export async function claimJobs(
  ctx: StageContext,
  stage: JobStage,
  limit: number
) {
  const now = new Date();
  return ctx.db
    .select()
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.stage, stage),
        // A row waiting out its backoff is not due yet.
        or(
          isNull(schema.jobs.nextAttemptAt),
          lte(schema.jobs.nextAttemptAt, now)
        ),
        notInArray(schema.jobs.status, CLOSED_JOB_STATUSES)
      )
    )
    // Oldest first, so a backlog drains in the order it arrived instead of
    // letting fresh rows perpetually jump the queue.
    .orderBy(asc(schema.jobs.id))
    .limit(limit);
}

export async function claimLeads(
  ctx: StageContext,
  stage: LeadStage,
  limit: number
) {
  const now = new Date();
  return ctx.db
    .select()
    .from(schema.leads)
    .where(
      and(
        eq(schema.leads.stage, stage),
        or(
          isNull(schema.leads.nextAttemptAt),
          lte(schema.leads.nextAttemptAt, now)
        ),
        notInArray(schema.leads.status, CLOSED_LEAD_STATUSES)
      )
    )
    .orderBy(asc(schema.leads.id))
    .limit(limit);
}

/**
 * Records a per-row failure: bump attempts, store the message, and either
 * schedule a backed-off retry or give up.
 *
 * Giving up moves the row to `done` with its error intact rather than deleting
 * or hiding it. A listing that can never be processed should be visible in the
 * dashboard and counted in the digest — silently vanishing rows are how a
 * broken source goes unnoticed for a month.
 */
export async function failJob(
  ctx: StageContext,
  jobId: number,
  attempts: number,
  err: unknown
) {
  const next = attempts + 1;
  const message = err instanceof Error ? err.message : String(err);
  const giveUp = !hasAttemptsLeft(next);
  await ctx.db
    .update(schema.jobs)
    .set({
      attempts: next,
      lastError: message.slice(0, 500),
      nextAttemptAt: giveUp ? null : nextAttemptAt(next, jobId),
      ...(giveUp ? { stage: "done" as const } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.jobs.id, jobId));

  ctx.errors.push(
    giveUp
      ? `job ${jobId}: gave up after ${MAX_ATTEMPTS} attempts - ${message}`
      : `job ${jobId}: attempt ${next} failed, will retry - ${message}`
  );
}

export async function failLead(
  ctx: StageContext,
  leadId: number,
  attempts: number,
  err: unknown
) {
  const next = attempts + 1;
  const message = err instanceof Error ? err.message : String(err);
  const giveUp = !hasAttemptsLeft(next);
  await ctx.db
    .update(schema.leads)
    .set({
      attempts: next,
      lastError: message.slice(0, 500),
      nextAttemptAt: giveUp ? null : nextAttemptAt(next, leadId),
      ...(giveUp ? { stage: "done" as const } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.leads.id, leadId));

  ctx.errors.push(
    giveUp
      ? `lead ${leadId}: gave up after ${MAX_ATTEMPTS} attempts - ${message}`
      : `lead ${leadId}: attempt ${next} failed, will retry - ${message}`
  );
}
