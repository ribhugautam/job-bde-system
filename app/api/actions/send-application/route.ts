import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/infra/db/client";
import { sendMail } from "@/lib/infra/mail/send";
import { getEnv } from "@/lib/config/env";
import { nextFollowUpDue } from "@/lib/pipeline/followup-schedule";
import { getApiActor } from "@/lib/infra/session";
import { getSenderIdentity } from "@/lib/infra/db/user-mail";

export const dynamic = "force-dynamic";

// Manual "send" for applications that need a human click - either because
// the job has no plain apply-email (most portals/LinkedIn/Indeed - you'll
// need to open the listing and paste the drafted cover letter in yourself),
// or because you want to review before an email send goes out.
export async function POST(req: NextRequest) {
  // proxy.ts proves only that the cookie is genuine; it cannot reach the
  // database, so it cannot tell whether the account behind it still exists
  // or is still active. Without this check a deactivated colleague keeps
  // full use of this route until their cookie expires -- up to 30 days.
  const actor = await getApiActor();
  if (!actor.ok) {
    return NextResponse.json({ error: actor.error }, { status: actor.status });
  }
  const { applicationId, overrideEmail } = await req.json();
  if (!applicationId) {
    return NextResponse.json({ error: "applicationId required" }, { status: 400 });
  }
  const db = getDb();
  const [app] = await db
    .select()
    .from(schema.applications)
    .where(eq(schema.applications.id, applicationId))
    .limit(1);
  if (!app) return NextResponse.json({ error: "not found" }, { status: 404 });

  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, app.jobId)).limit(1);
  const to = overrideEmail || job?.applyEmail;
  if (!to) {
    return NextResponse.json(
      { error: "No email address available - this job requires applying via its own portal/URL. Open the job's url field and apply there, pasting in the drafted cover letter." },
      { status: 400 }
    );
  }


  // Sent as the person clicking, from THEIR mailbox. There is deliberately no
  // fallback to a shared address: a colleague's application arriving from
  // somebody else's mailbox, signed with somebody else's name, at a real
  // company, is the failure this whole design exists to prevent.
  const sender = await getSenderIdentity(actor.user.id);
  if (!sender) {
    return NextResponse.json(
      {
        error:
          "Your sending mailbox is not set up (or has not been verified yet). " +
          "Add it on the Settings page, then try again.",
      },
      { status: 400 }
    );
  }

  const result = await sendMail({
    from: sender,
    to,
    subject: `Application: ${job?.title || "Role"}`,
    text: app.coverLetter,
  });

  if (result.ok) {
    const sentAt = new Date();
    await db
      .update(schema.applications)
      .set({
        status: "sent",
        sentAt,
        sentTo: to,
        // Without this the reply matcher has nothing to anchor on, and the
        // follow-up sequence would keep emailing someone who already replied.
        // It fails silently if omitted, which is why it is not optional here.
        messageId: result.messageId,
        nextFollowUpAt: nextFollowUpDue(0, sentAt, getEnv()),
      })
      .where(eq(schema.applications.id, applicationId));
    if (job) {
      await db
        .update(schema.jobs)
        .set({ status: "sent", updatedAt: new Date() })
        .where(eq(schema.jobs.id, job.id));
    }
    return NextResponse.json({ ok: true });
  }
  await db
    .update(schema.applications)
    .set({ status: "failed", error: result.error })
    .where(eq(schema.applications.id, applicationId));
  return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
}
