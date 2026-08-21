import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, getAuthConfig, verifySessionToken } from "./auth";
import { findUserById, type PublicUser } from "./db/users";
import { canManageUsers } from "@/lib/domain/users/roles";

// ---------------------------------------------------------------------------
// THE authority on who is making a request.
//
// proxy.ts runs on the Edge and can only check that a cookie carries a genuine,
// unexpired signature. It cannot reach the database, so it cannot know whether
// the user named in that cookie still exists or is still active — a
// deactivated person's cookie stays cryptographically valid until it expires.
//
// That gap closes here. getSessionUser() loads the row and rejects anyone who
// is gone or switched off, and it is the ONLY thing in the app permitted to
// answer "who is this". Reading the cookie directly anywhere else re-opens the
// gap, quietly, in whichever route did it.
// ---------------------------------------------------------------------------

export async function getSessionUser(): Promise<PublicUser | null> {
  const auth = getAuthConfig();
  if (!auth) return null;

  const jar = await cookies();
  const claims = await verifySessionToken(
    jar.get(SESSION_COOKIE)?.value,
    auth.secret
  );
  if (!claims) return null;

  const user = await findUserById(claims.userId);
  // Both conditions matter: the row can be missing (deleted by hand) or
  // present but deactivated. Either way the cookie is stale, not trusted.
  if (!user || !user.isActive) return null;

  return user;
}

/**
 * For pages. Sends anyone without a live session to the login screen.
 *
 * Note this can fire even though proxy.ts already let the request through —
 * that is the deactivation case, and it is exactly the behaviour we want: the
 * next page load after being switched off returns you to the login screen.
 */
export async function requireUser(nextPath?: string): Promise<PublicUser> {
  const user = await getSessionUser();
  if (!user) {
    redirect(nextPath ? `/login?next=${encodeURIComponent(nextPath)}` : "/login");
  }
  return user;
}

/** For pages that only admins may see. */
export async function requireAdmin(): Promise<PublicUser> {
  const user = await requireUser("/dashboard/team");
  if (!canManageUsers(user.role)) redirect("/dashboard");
  return user;
}

export type ApiActor =
  | { ok: true; user: PublicUser }
  | { ok: false; status: 401 | 403; error: string };

/**
 * For API routes, which must answer with JSON rather than redirect — the
 * dashboard's fetch() calls parse res.json(), and a 307 to an HTML login page
 * blows up there with a confusing parse error. Same rule as the pages: this is
 * the only sanctioned way for a route to learn who is calling it.
 */
export async function getApiActor(opts?: { admin?: boolean }): Promise<ApiActor> {
  const user = await getSessionUser();
  if (!user) return { ok: false, status: 401, error: "unauthorized" };
  if (opts?.admin && !canManageUsers(user.role)) {
    return { ok: false, status: 403, error: "admin only" };
  }
  return { ok: true, user };
}
