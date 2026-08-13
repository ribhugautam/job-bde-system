import type { Env } from "@/lib/config/env";
import type { Deadline } from "./deadline";
import { getDb } from "@/lib/infra/db/client";

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
  env: Env;
  deadline: Deadline;
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
