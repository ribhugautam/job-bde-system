import { NextRequest, NextResponse } from "next/server";
import { getApiActor } from "@/lib/infra/session";
import {
  clearJobStatusForUser,
  setJobStatusForUser,
} from "@/lib/infra/db/job-state";
import { JOB_STATUSES } from "@/lib/pipeline/state";

export const dynamic = "force-dynamic";

/**
 * Sets (or clears) the CALLING USER's status for one job.
 *
 * Deliberately NOT /api/actions/update-status, which writes `jobs.status` — a
 * column shared by every user and owned by the unattended pipeline. Routing
 * triage through that would mean one colleague dismissing a job hid it from
 * everybody, which is exactly what a shared pool with private state must not
 * do.
 *
 * The user id comes from the session and is never accepted from the body:
 * nobody may triage on somebody else's behalf.
 */
export async function POST(req: NextRequest) {
  const actor = await getApiActor();
  if (!actor.ok) {
    return NextResponse.json({ error: actor.error }, { status: actor.status });
  }

  let jobId: unknown;
  let status: unknown;
  try {
    ({ jobId, status } = await req.json());
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  if (typeof jobId !== "number" || !Number.isSafeInteger(jobId)) {
    return NextResponse.json({ error: "jobId (number) required" }, { status: 400 });
  }

  // null clears the row, returning the job to genuinely untriaged. See the note
  // on clearJobStatusForUser: that is NOT the same as storing `found`, because
  // only a job with no row of its own is subject to auto-expiry.
  if (status === null) {
    await clearJobStatusForUser(actor.user.id, jobId);
    return NextResponse.json({ ok: true });
  }

  if (typeof status !== "string" || !JOB_STATUSES.includes(status as never)) {
    return NextResponse.json(
      { error: `status must be null or one of: ${JOB_STATUSES.join(", ")}` },
      { status: 400 }
    );
  }

  await setJobStatusForUser(actor.user.id, jobId, status);
  return NextResponse.json({ ok: true });
}
