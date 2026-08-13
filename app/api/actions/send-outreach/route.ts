import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/infra/db/client";
import { sendMail } from "@/lib/infra/mail/send";
import { getEnv } from "@/lib/config/env";
import { nextFollowUpDue } from "@/lib/pipeline/followup-schedule";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
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

  const result = await sendMail({
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
