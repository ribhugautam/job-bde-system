import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/infra/db/client";
import { sendMail } from "@/lib/infra/mail/send";
import { getEnv } from "@/lib/config/env";
import { nextFollowUpDue } from "@/lib/pipeline/followup-schedule";
import { getApiActor } from "@/lib/infra/session";
import { getSenderIdentity } from "@/lib/infra/db/user-mail";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // proxy.ts proves only that the cookie is genuine; it cannot reach the
  // database, so it cannot tell whether the account behind it still exists
  // or is still active. Without this check a deactivated colleague keeps
  // full use of this route until their cookie expires -- up to 30 days.
  const actor = await getApiActor();
  if (!actor.ok) {
    return NextResponse.json({ error: actor.error }, { status: actor.status });
  }
  const { outreachId, overrideEmail } = await req.json();
  if (!outreachId) {
    return NextResponse.json({ error: "outreachId required" }, { status: 400 });
  }
  const db = getDb();
  const [pitch] = await db
    .select()
    .from(schema.outreach)
    .where(eq(schema.outreach.id, outreachId))
    .limit(1);
  if (!pitch) return NextResponse.json({ error: "not found" }, { status: 404 });

  const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.id, pitch.leadId)).limit(1);
  const to = overrideEmail || lead?.contactEmail;
  if (!to) {
    return NextResponse.json(
      { error: "No contact email on file for this lead - open the lead's url and pitch directly through that platform's messaging." },
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
    subject: `Re: ${lead?.title || "your job post"}`,
    text: pitch.pitch,
  });

  if (result.ok) {
    const sentAt = new Date();
    await db
      .update(schema.outreach)
      .set({
        status: "sent",
        sentAt,
        sentTo: to,
        // See the note in send-application: omitting this breaks reply
        // detection silently rather than loudly.
        messageId: result.messageId,
        nextFollowUpAt: nextFollowUpDue(0, sentAt, getEnv()),
      })
      .where(eq(schema.outreach.id, outreachId));
    if (lead) {
      await db
        .update(schema.leads)
        .set({ status: "sent", updatedAt: new Date() })
        .where(eq(schema.leads.id, lead.id));
    }
    return NextResponse.json({ ok: true });
  }
  await db
    .update(schema.outreach)
    .set({ status: "failed", error: result.error })
    .where(eq(schema.outreach.id, outreachId));
  return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
}
