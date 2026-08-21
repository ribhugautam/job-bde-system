import { getAppConfig } from "@/lib/config/app-config";
import { getDb, schema } from "@/lib/infra/db/client";
import { getOwnerUserId } from "@/lib/infra/db/users";
import { getOwnerSenderIdentity } from "@/lib/infra/db/user-mail";
import {
  createDeadline,
  BATCH_RESERVE_MS,
  TAIL_RESERVE_MS,
  type Deadline,
} from "./deadline";
import {
  emptyCounters,
  recordError,
  type Counters,
  type Stage,
  type StageContext,
} from "./context";
import { runIngest } from "./stages/ingest";
import { runEnrich } from "./stages/enrich";
import { runScore } from "./stages/score";
import { runDraft } from "./stages/draft";
import { runDispatch } from "./stages/dispatch";
import { runWatch } from "./stages/watch";
import { runFollowUp } from "./stages/followup";
import { buildSummary, sendDigestEmail } from "./stages/digest";

export type RunSummary = {
  dryRun: boolean;
  /** Things that broke and need fixing. */
  errors: string[];
  /** Things worth knowing that are working as configured. */
  notices: string[];
  counters: Counters;
  /** True when the clock ran out with work still queued. */
  budgetExhausted: boolean;
  elapsedMs: number;
};

/**
 * Stages that move an individual row forward, in dependency order.
 *
 * Drained round-robin rather than one-stage-to-completion. Running enrich to
 * exhaustion first would mean a run that times out during enrichment never
 * drafts or sends anything at all, even for jobs that were ready to go — the
 * backlog would starve the front of the queue indefinitely. Round-robin keeps
 * every stage making progress on every invocation.
 */
const DRAIN_STAGES: ReadonlyArray<{ name: string; run: Stage }> = [
  { name: "enrich", run: runEnrich },
  { name: "score", run: runScore },
  { name: "draft", run: runDraft },
  { name: "dispatch", run: runDispatch },
];

/**
 * One invocation of the pipeline.
 *
 * Safe to call concurrently with itself only in the sense that it will not
 * corrupt data — the unique index on (source, source_id) makes ingest
 * idempotent and every stage claims rows before working them. It is not
 * designed to be *fast* under concurrency, and the cron only ever fires one.
 */
export async function runWorker(): Promise<RunSummary> {
  const config = await getAppConfig();
  const db = getDb();
  const deadline: Deadline = createDeadline(config.WORKER_TIME_BUDGET_MS);

  // Resolved once per run rather than per send: it is the same answer every
  // time, and a run that cannot send at all should say so once in the digest
  // instead of failing item by item.
  const ownerUserId = await getOwnerUserId();
  const sender = await getOwnerSenderIdentity(ownerUserId);

  const ctx: StageContext = {
    db,
    config,
    deadline,
    sender,
    ownerUserId,
    counters: emptyCounters(),
    errors: [],
    notices: [],
  };

  if (!sender) {
    // A notice, not an error: drafting everything and queueing it is the
    // correct behaviour, not a failure. It is still the most valuable thing to
    // act on, so it is stated plainly rather than inferred from zero sends.
    ctx.notices.push(
      "No sending mailbox is configured, so nothing can be sent -- everything " +
        "is being drafted and queued for one-click sending instead. Set one up " +
        "on the Settings page, or set GMAIL_USER/GMAIL_APP_PASSWORD."
    );
  }

  let budgetExhausted = false;

  // --- 1. Ingest ----------------------------------------------------------
  // Runs once per invocation rather than in the drain loop: it is a fetch-all
  // across every source, not a per-row batch, and running it twice in one run
  // would just re-fetch the same feeds.
  try {
    await runIngest(ctx);
  } catch (err) {
    // Ingest failing wholesale (rather than one source failing, which
    // safeFetchSource already absorbs) must not stop the run — there may be a
    // backlog from previous runs that still deserves to be drafted and sent.
    recordError(ctx, "ingest", err);
  }

  // --- 2. Drain the per-row stages ----------------------------------------
  // Loop until nothing moved. `progressed` is what terminates this: if a full
  // pass over every stage handles zero rows, the queue is empty and spinning
  // again would just re-run the same queries.
  const DRAIN_RESERVE_MS = TAIL_RESERVE_MS + BATCH_RESERVE_MS;
  let progressed = true;
  // Whether any stage still had rows it could not reach on its most recent
  // call. Combined with running out of clock, this is what distinguishes
  // "finished the queue" from "ran out of time mid-queue".
  let workRemains = false;

  while (progressed && deadline.hasBudget(DRAIN_RESERVE_MS)) {
    progressed = false;
    workRemains = false;
    for (const stage of DRAIN_STAGES) {
      if (!deadline.hasBudget(DRAIN_RESERVE_MS)) {
        // Out of clock partway through a pass. Anything after this stage in
        // DRAIN_STAGES was not consulted, so we cannot claim the queue is
        // drained.
        workRemains = true;
        break;
      }
      try {
        const result = await stage.run(ctx);
        if (result.processed > 0) progressed = true;
        if (result.hasMore) workRemains = true;
      } catch (err) {
        // A stage should handle its own per-row failures. Reaching here means
        // something broke at the batch level (a bad query, a claim failure);
        // record it and let the other stages continue.
        recordError(ctx, `stage ${stage.name}`, err);
      }
    }
  }

  // Exhausted means we stopped because of the clock while work was still
  // queued — not merely that the clock is low. A run that drains everything
  // and then has little budget left is a healthy run, not a degraded one.
  budgetExhausted = workRemains && !deadline.hasBudget(DRAIN_RESERVE_MS);

  // --- 3. Tail stages -----------------------------------------------------
  // These run on the reserve, outside the drain loop, because they must happen
  // on every invocation. Watch runs BEFORE followup on purpose: detecting a
  // reply cancels a pending follow-up, and the other order would send a nudge
  // to someone who had already answered.
  try {
    await runWatch(ctx);
  } catch (err) {
    recordError(ctx, "watch", err);
  }

  try {
    await runFollowUp(ctx);
  } catch (err) {
    recordError(ctx, "followup", err);
  }

  // --- 4. Digest ----------------------------------------------------------
  const summary = buildSummary(ctx, { budgetExhausted });

  // The digest row is written even when the email fails, so a run is always
  // auditable from the dashboard. This is the last thing to go wrong quietly.
  try {
    await db.insert(schema.digestLogs).values({
      newJobs: ctx.counters.newJobs,
      newLeads: ctx.counters.newLeads,
      duplicatesMerged: ctx.counters.duplicatesMerged,
      jobsEnriched: ctx.counters.jobsEnriched,
      applicationsAutoSent: ctx.counters.applicationsAutoSent,
      applicationsQueued: ctx.counters.applicationsQueued,
      outreachAutoSent: ctx.counters.outreachAutoSent,
      outreachQueued: ctx.counters.outreachQueued,
      repliesDetected: ctx.counters.repliesDetected,
      followUpsSent: ctx.counters.followUpsSent,
      budgetExhausted,
      errors: ctx.errors,
      summary,
    });
  } catch (err) {
    recordError(ctx, "digest log", err);
  }

  try {
    await sendDigestEmail(ctx, summary);
  } catch (err) {
    recordError(ctx, "digest email", err);
  }

  return {
    dryRun: config.dryRun,
    counters: ctx.counters,
    errors: ctx.errors,
    notices: ctx.notices,
    budgetExhausted,
    elapsedMs: deadline.elapsed(),
  };
}
