// ---------------------------------------------------------------------------
// Wall-clock budget for a single worker invocation.
//
// The worker runs inside a serverless function with a hard `maxDuration`. Being
// killed mid-write is the failure mode worth engineering against: it strands
// rows in whatever stage they were in and, worse, can drop the digest that would
// have told anyone something went wrong.
//
// So the worker never runs to the edge. It stops while it still has a reserve
// large enough to finish the tail (reply scan, follow-ups, digest write+send)
// and leaves the remaining work for the next invocation — which is safe
// precisely because every stage is resumable.
// ---------------------------------------------------------------------------

export type Deadline = {
  /** Milliseconds left in the budget. Never negative. */
  remaining(): number;
  /** True while there is more than `reserveMs` left. */
  hasBudget(reserveMs: number): boolean;
  /** Milliseconds consumed so far. */
  elapsed(): number;
  expired(): boolean;
};

/**
 * `now` is injectable so tests can drive the clock deterministically instead of
 * sleeping. A test that has to wait in real time to verify budget behavior is a
 * test nobody will keep running.
 */
export function createDeadline(
  budgetMs: number,
  now: () => number = () => Date.now()
): Deadline {
  const startedAt = now();
  const elapsed = () => now() - startedAt;
  const remaining = () => Math.max(0, budgetMs - elapsed());
  return {
    remaining,
    elapsed,
    hasBudget: (reserveMs: number) => remaining() > reserveMs,
    expired: () => remaining() <= 0,
  };
}

/**
 * Budget held back for the tail stages. Watch + follow-ups + digest are the
 * stages that must not be skipped: the digest is the only channel that reports
 * a run went wrong, and skipping the reply scan means follow-ups get sent to
 * people who already answered.
 */
export const TAIL_RESERVE_MS = 12_000;

/** Minimum budget worth starting another drain batch with. */
export const BATCH_RESERVE_MS = 5_000;
