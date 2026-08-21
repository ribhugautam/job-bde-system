import { NextRequest, NextResponse } from "next/server";
import { getApiActor } from "@/lib/infra/session";
import { createInvite } from "@/lib/infra/db/invites";
import { parseRole } from "@/lib/domain/users/roles";

export const dynamic = "force-dynamic";

/**
 * Creates an invite and returns the one-time link.
 *
 * proxy.ts only proves the caller holds a valid session cookie — it cannot
 * tell a member from an admin, or a live account from a deactivated one. That
 * check has to happen here, which is what getApiActor({ admin: true }) is for.
 */
export async function POST(req: NextRequest) {
  const actor = await getApiActor({ admin: true });
  if (!actor.ok) {
    return NextResponse.json({ error: actor.error }, { status: actor.status });
  }

  let email = "";
  let role = "member";
  try {
    const body = await req.json();
    email = typeof body?.email === "string" ? body.email : "";
    role = typeof body?.role === "string" ? body.role : "member";
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const result = await createInvite({
    email,
    // parseRole degrades anything unrecognised to the least privileged role,
    // so a hand-crafted request cannot mint an admin by inventing a value.
    role: parseRole(role),
    createdByUserId: actor.user.id,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  // Returned once. There is no way to see this token again — the admin copies
  // the link now or issues a fresh invite.
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  return NextResponse.json({
    ok: true,
    id: result.id,
    url: `${base}/invite/${result.token}`,
  });
}
