import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";

export const dynamic = "force-dynamic";

const JOB_STATUSES = [
  "found", "matched", "ready_for_review", "sent", "responded",
  "interview", "offer", "rejected", "ignored",
];
const LEAD_STATUSES = [
  "found", "matched", "pitched", "sent", "responded",
  "won", "lost", "ignored",
];

export async function POST(req: NextRequest) {
  const { entity, id, status } = await req.json();
  if (!["job", "lead"].includes(entity) || !id || !status) {
    return NextResponse.json({ error: "entity ('job'|'lead'), id, status required" }, { status: 400 });
  }
  const allowed = entity === "job" ? JOB_STATUSES : LEAD_STATUSES;
  if (!allowed.includes(status)) {
    return NextResponse.json({ error: `status must be one of: ${allowed.join(", ")}` }, { status: 400 });
  }
  const db = getDb();
  if (entity === "job") {
    await db.update(schema.jobs).set({ status, updatedAt: new Date() }).where(eq(schema.jobs.id, id));
  } else {
    await db.update(schema.leads).set({ status, updatedAt: new Date() }).where(eq(schema.leads.id, id));
  }
  return NextResponse.json({ ok: true });
}
