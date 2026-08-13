import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/infra/db/client";
// Single source of truth — these lists were previously duplicated here and in
// the dashboard pages, and had already drifted apart from each other.
import { JOB_STATUSES, LEAD_STATUSES } from "@/lib/pipeline/state";

export const dynamic = "force-dynamic";

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
