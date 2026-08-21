import type { AppConfig } from "@/lib/config/app-config";
import type { Deadline } from "./deadline";
import { getDb } from "@/lib/infra/db/client";
import type { SenderIdentity } from "@/lib/infra/db/user-mail";

export type Db = ReturnType<typeof getDb>;

/**
 * Counters accumulated across a run and written to `digest_logs`.
 *
 * Deliberately a flat bag of numbers rather than each stage returning its own
 * shape: the digest has to render a single coherent summary, and threading
 * eight different result types into it produced more plumbing than insight.
 */
export type Counters = {
  newJobs: number;
  newLeads: number;
  duplicatesMerged: number;
  jobsEnriched: number;
  applicationsAutoSent: number;
  applicationsQueued: number;
  outreachAutoSent: number;
  outreachQueued: number;
  repliesDetected: number;
  followUpsSent: number;
};

export function emptyCounters(): Counters {
  return {
    newJobs: 0,
    newLeads: 0,
    duplicatesMerged: 0,
    jobsEnriched: 0,
    applicationsAutoSent: 0,
    applicationsQueued: 0,
    outreachAutoSent: 0,
    outreachQueued: 0,
    repliesDetected: 0,
    followUpsSent: 0,
  };
}

export type StageContext = {
  db: Db;
  /**
   * Secrets AND runtime settings, resolved once at the start of the run.
   *
   * Named `config` rather than `env` deliberately: most of what a stage reads
   * from it now comes from the database, and `ctx.env.MATCH_THRESHOLD` would
   * send a reader to Vercel looking for a value that is not there.
   *
   * Read `config.dryRun`, never `config.DRY_RUN` -- only the former combines
   * the settings toggle with the deploy-level env override.
   */
  config: AppConfig;
  deadline: Deadline;

  /**
   * Who the unattended run sends as, resolved once at the start of the run.
   *
   * NULL means no usable mailbox, and every stage treats that as "draft and
   * queue, do not send" rather than falling back to some other sender. There is
   * no deployment-wide From address to fall back TO any more, and inventing one
   * would mean a colleague's mail leaving under the wrong name.
   *
   * The pipeline still runs ONE shared queue rather than one per person, so
   * this is the owner's identity -- the same single mailbox it used before
   * accounts existed. Per-user queues are a larger change; what matters here is
   * that the address is now explicit rather than ambient.
   */
  sender: SenderIdentity | null;

  /**
   * Which user the unattended run acts on behalf of, resolved once per run.
   *
   * Everything the pipeline creates -- applications, outreach -- is stamped
   * with this, so a draft knows whose voice it is in, whose CV to attach and
   * whose mailbox to leave from. Null only on a deployment with no admin
   * account, which db:migrate is what prevents.
   */
  ownerUserId: number | null;
  counters: Counters;
  /**
   * Things that went WRONG: a source returned 400, a send failed, a row could
   * not be processed. A stage appends here and keeps going; the digest reports
   * them. Nothing in the pipeline should throw past its stage boundary for a
   * condition that only affects one row — a single malformed listing must never
   * cost the other 200.
   */
  errors: string[];

  /**
   * Things that are merely WORTH KNOWING: a source is switched off, no resume
   * is uploaded, a cap was reached. Deliberately separate from `errors`.
   *
   * These used to share one list, and the result was a digest reporting "5
   * errors" when two sources were genuinely broken and three lines were just
   * describing configuration. Burying real failures among expected ones is how
   * a broken source goes unnoticed for a month.
   */
  notices: string[];
};

export type StageResult = {
  /** Rows handled this call. Zero means the stage has nothing queued. */
  processed: number;
  /** True when rows remain that this stage could not reach within budget. */
  hasMore: boolean;
};

export const NOTHING_TO_DO: StageResult = { processed: 0, hasMore: false };

/** A stage: drains at most one batch and reports whether more remains. */
export type Stage = (ctx: StageContext) => Promise<StageResult>;

export function recordError(ctx: StageContext, scope: string, err: unknown) {
  ctx.errors.push(
    `${scope}: ${err instanceof Error ? err.message : String(err)}`
  );
}

export function recordNotice(ctx: StageContext, message: string) {
  ctx.notices.push(message);
}
