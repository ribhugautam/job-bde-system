import { and, eq } from "drizzle-orm";
import { getDb, schema } from "./client";

// ---------------------------------------------------------------------------
// Writing one person's state for one job.
//
// A row appears here the first time somebody acts on a job and never before —
// that absence IS the "untriaged" state, and it is what keeps this table
// proportional to actions rather than to users x jobs. See
// lib/domain/jobs/buckets.ts.
// ---------------------------------------------------------------------------

export async function setJobStatusForUser(
  userId: number,
  jobId: number,
  status: string
): Promise<void> {
  const db = getDb();
  const now = new Date();

  // Upsert on the composite key. Doing this as select-then-insert-or-update
  // would race two clicks against each other; the unique constraint makes the
  // database settle it instead.
  await db
    .insert(schema.jobUserState)
    .values({ userId, jobId, status, triagedAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [schema.jobUserState.userId, schema.jobUserState.jobId],
      // triagedAt is deliberately NOT updated: it records when this person
      // first dealt with the job, and overwriting it on every later change
      // would turn a first-touch timestamp into a duplicate of updatedAt.
      set: { status, updatedAt: now },
    });
}

export async function getJobStatusForUser(
  userId: number,
  jobId: number
): Promise<string | null> {
  const db = getDb();
  const [row] = await db
    .select({ status: schema.jobUserState.status })
    .from(schema.jobUserState)
    .where(
      and(
        eq(schema.jobUserState.userId, userId),
        eq(schema.jobUserState.jobId, jobId)
      )
    )
    .limit(1);
  return row?.status ?? null;
}

/**
 * Undoes a triage decision by DELETING the row rather than writing `found`.
 *
 * The two are not equivalent. A job with no row is untriaged and subject to
 * auto-expiry; a job explicitly parked at `found` looks identical in the inbox
 * but would need its own expiry handling. Deleting keeps exactly one
 * representation of "I have not dealt with this", so restore genuinely returns
 * a job to the state it was in before it was ever touched.
 */
export async function clearJobStatusForUser(
  userId: number,
  jobId: number
): Promise<void> {
  const db = getDb();
  await db
    .delete(schema.jobUserState)
    .where(
      and(
        eq(schema.jobUserState.userId, userId),
        eq(schema.jobUserState.jobId, jobId)
      )
    );
}
