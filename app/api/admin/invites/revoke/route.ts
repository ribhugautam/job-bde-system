import { NextRequest, NextResponse } from "next/server";
import { getApiActor } from "@/lib/infra/session";
import { revokeInvite } from "@/lib/infra/db/invites";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const actor = await getApiActor({ admin: true });
  if (!actor.ok) {
    return NextResponse.json({ error: actor.error }, { status: actor.status });
  }

  let id: unknown;
  try {
    ({ id } = await req.json());
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  if (typeof id !== "number" || !Number.isSafeInteger(id)) {
    return NextResponse.json({ error: "id (number) required" }, { status: 400 });
  }

  // revokeInvite deliberately no-ops on an already-accepted invite: revoking
  // one after the fact would suggest the account it created is somehow undone,
  // which it is not. Deactivate the user instead.
  await revokeInvite(id);
  return NextResponse.json({ ok: true });
}
