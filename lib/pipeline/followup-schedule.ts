// ---------------------------------------------------------------------------
// When the next follow-up is due.
//
// Pure and parameterised rather than reading env directly, so it can be unit
// tested across day boundaries without touching a clock or a config file.
//
// The sequence is deliberately short and finite: one nudge, one final message,
// then nothing. Ever. An unattended system that keeps emailing strangers on a
// schedule nobody is watching is a way to damage a reputation at scale, and the
// third message has never been the one that gets the reply.
// ---------------------------------------------------------------------------

export const MAX_FOLLOW_UPS = 2;

export type FollowUpConfig = {
  ENABLE_FOLLOWUPS: boolean;
  FOLLOWUP_FIRST_DAYS: number;
  FOLLOWUP_FINAL_DAYS: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The due date for the next follow-up after `sentCount` have already gone out,
 * or null when the sequence is finished or disabled.
 *
 * Both offsets are measured from the ORIGINAL send, not from the previous
 * follow-up. Chaining off the previous one lets delivery delays compound, so a
 * "day 10" message could land on day 14 — and the gap the user configured would
 * quietly stop meaning what it says.
 */
export function nextFollowUpDue(
  sentCount: number,
  originalSentAt: Date,
  config: FollowUpConfig
): Date | null {
  if (!config.ENABLE_FOLLOWUPS) return null;
  if (sentCount >= MAX_FOLLOW_UPS) return null;

  const offsetDays =
    sentCount === 0 ? config.FOLLOWUP_FIRST_DAYS : config.FOLLOWUP_FINAL_DAYS;

  return new Date(originalSentAt.getTime() + offsetDays * DAY_MS);
}

/** 1 for the first nudge, 2 for the final one. */
export function followUpStep(sentCount: number): 1 | 2 {
  return sentCount === 0 ? 1 : 2;
}
