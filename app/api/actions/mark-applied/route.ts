import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/infra/db/client";

export const dynamic = "force-dynamic";

/**
 * Marks a queued job as applied — or undoes that.
 *
 * The queue UI updates optimistically and calls this in the background, so the
 * keystroke feels instant. That makes idempotency a requirement rather than a
 * nicety: a double-tap, a retried request, or an undo racing the original must
 * all converge on the same state.
 *
 * Undo deliberately restores `ready_for_review` rather than recomputing a
 * status: the row only reaches this endpoint from the queue, so that is the
 * only state it could have come from, and guessing anything else would be a
 * way to silently lose an item.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { jobId, undo } = (body ?? {}) as { jobId?: unknown; undo?: unknown };
  if (typeof jobId !== "number" || !Number.isInteger(jobId) || jobId <= 0) {
    return NextResponse.json(
      { error: "jobId (positive integer) required" },
      { status: 400 }
    );
  }

  const isUndo = undo === true;
  const nextStatus = isUndo ? "ready_for_review" : "applied";
  const db = getDb();

  const [job] = await db
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(eq(schema.jobs.id, jobId))
    .limit(1);
  if (!job) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }

  await db
    .update(schema.jobs)
    .set({ status: nextStatus, updatedAt: new Date() })
    .where(eq(schema.jobs.id, jobId));

  // Keep the application row in step. Scoped to `manual_portal` so this can
  // never overwrite the status of something the pipeline actually emailed —
  // an auto-sent application's "sent" state is a record of a real event and
  // must not be rewritten by a UI click.
  await db
    .update(schema.applications)
    .set({
      status: isUndo ? "ready_for_review" : "sent",
      sentAt: isUndo ? null : new Date(),
    })
    .where(
      and(
        eq(schema.applications.jobId, jobId),
        eq(schema.applications.sendMode, "manual_portal")
      )
    );

  return NextResponse.json({ ok: true, status: nextStatus });
}
