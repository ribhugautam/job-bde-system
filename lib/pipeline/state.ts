// ---------------------------------------------------------------------------
// The pipeline state machine.
//
// Two orthogonal axes, deliberately kept separate:
//
//   stage  — worker bookkeeping. "What is the next thing to DO to this row?"
//            The worker claims rows by (stage, nextAttemptAt). Internal.
//
//   status — the pipeline position a human reads in the dashboard
//            ("matched", "ready_for_review", "sent"). User-facing.
//
// Collapsing them into one column was the tempting option and the wrong one: a
// row can be `status=matched` while its next action is either drafting or a
// retry of a failed draft, and one column cannot say both without encoding
// retry state into a name the dashboard then has to render.
// ---------------------------------------------------------------------------

export const JOB_STAGES = [
  "enrich",
  "score",
  "draft",
  "dispatch",
  "done",
] as const;
export type JobStage = (typeof JOB_STAGES)[number];

// Leads have no enrich step: RSS/feed leads arrive with whatever description
// they will ever have, and there is no public page to recover more from.
export const LEAD_STAGES = ["score", "draft", "dispatch", "done"] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

export const JOB_STATUSES = [
  "found",
  "matched",
  "rejected",
  "ready_for_review",
  "applied",
  "sent",
  "responded",
  "interview",
  "offer",
  "closed",
  "ignored",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const LEAD_STATUSES = [
  "found",
  "matched",
  "rejected",
  "ready_for_review",
  // Retained for backwards compatibility: rows written before the stage machine
  // used "pitched" where a job would have said "ready_for_review". Dropping it
  // would make existing rows fail validation on the status-update endpoint.
  "pitched",
  "sent",
  "responded",
  "won",
  "lost",
  "ignored",
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** The stage that follows a successful run of `stage`. */
const NEXT_JOB_STAGE: Record<JobStage, JobStage> = {
  enrich: "score",
  score: "draft",
  draft: "dispatch",
  dispatch: "done",
  done: "done",
};

const NEXT_LEAD_STAGE: Record<LeadStage, LeadStage> = {
  score: "draft",
  draft: "dispatch",
  dispatch: "done",
  done: "done",
};

export function nextJobStage(stage: JobStage): JobStage {
  return NEXT_JOB_STAGE[stage];
}

export function nextLeadStage(stage: LeadStage): LeadStage {
  return NEXT_LEAD_STAGE[stage];
}

/**
 * Terminal statuses. Once a row reaches one of these the worker must never
 * pick it up again, whatever its stage says — this is the guard that stops a
 * human "ignore" click being undone by a retry that was already in flight.
 */
const TERMINAL_JOB_STATUSES = new Set<JobStatus>([
  "rejected",
  "ignored",
  "closed",
]);

const TERMINAL_LEAD_STATUSES = new Set<LeadStatus>([
  "rejected",
  "ignored",
  "won",
  "lost",
]);

export function isJobTerminal(status: string): boolean {
  return TERMINAL_JOB_STATUSES.has(status as JobStatus);
}

export function isLeadTerminal(status: string): boolean {
  return TERMINAL_LEAD_STATUSES.has(status as LeadStatus);
}

/**
 * Give up after this many failures. The row keeps its `lastError`, moves to
 * stage `done`, and is reported in the digest — it is never silently dropped,
 * because a source that starts failing should be visible, not invisible.
 */
export const MAX_ATTEMPTS = 5;

/**
 * Exponential backoff with a deterministic jitter derived from the row id.
 *
 * Deterministic rather than random so the same row retried twice lands in the
 * same slot (tests can assert on it), while different rows failing in the same
 * batch still spread out instead of stampeding the same upstream on every run.
 */
export function nextAttemptDelayMs(attempts: number, seed = 0): number {
  const base = Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 6 * 60 * 60_000);
  const jitter = (seed % 17) * 1_000;
  return base + jitter;
}

export function nextAttemptAt(
  attempts: number,
  seed = 0,
  now: Date = new Date()
): Date {
  return new Date(now.getTime() + nextAttemptDelayMs(attempts, seed));
}

export function hasAttemptsLeft(attempts: number): boolean {
  return attempts < MAX_ATTEMPTS;
}
