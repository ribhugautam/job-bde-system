import { NextRequest, NextResponse } from "next/server";
import { getApiActor } from "@/lib/infra/session";
import { setUserActive, setUserRole } from "@/lib/infra/db/users";
import { USER_ROLES, type UserRole } from "@/lib/domain/users/roles";

export const dynamic = "force-dynamic";

/**
 * Deactivates/reactivates a user, or changes their role.
 *
 * The last-active-admin guard lives in lib/infra/db/users.ts rather than here,
 * because it has to hold for every caller — including a future script — not
 * just for requests that happen to arrive through this route.
 */
export async function POST(req: NextRequest) {
  const actor = await getApiActor({ admin: true });
  if (!actor.ok) {
    return NextResponse.json({ error: actor.error }, { status: actor.status });
  }

  let userId: unknown;
  let isActive: unknown;
  let role: unknown;
  try {
    ({ userId, isActive, role } = await req.json());
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  if (typeof userId !== "number" || !Number.isSafeInteger(userId)) {
    return NextResponse.json({ error: "userId (number) required" }, { status: 400 });
  }

  // Self-lockout guard. The last-admin check in users.ts already stops the
  // deployment losing its only admin, but this catches the narrower and much
  // likelier mistake: an admin clicking the wrong row and switching THEMSELVES
  // off while other admins still exist, so the guard there would not fire.
  if (userId === actor.user.id) {
    if (isActive === false) {
      return NextResponse.json(
        { error: "You cannot deactivate your own account." },
        { status: 400 }
      );
    }
    if (typeof role === "string" && role !== "admin") {
      return NextResponse.json(
        { error: "You cannot remove your own admin role." },
        { status: 400 }
      );
    }
  }

  if (typeof role === "string") {
    if (!(USER_ROLES as readonly string[]).includes(role)) {
      return NextResponse.json(
        { error: `role must be one of: ${USER_ROLES.join(", ")}` },
        { status: 400 }
      );
    }
    const result = await setUserRole(userId, role as UserRole);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  }

  if (typeof isActive === "boolean") {
    const result = await setUserActive(userId, isActive);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
