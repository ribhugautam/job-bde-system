import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  createSessionToken,
  getAuthConfig,
} from "@/lib/infra/auth";
import { acceptInvite } from "@/lib/infra/db/invites";

export const dynamic = "force-dynamic";

/**
 * Redeems an invite token and signs the new account in.
 *
 * PUBLIC by necessity — see proxy.ts. There is no session yet, so the token in
 * the body is the entire credential; acceptInvite() enforces that it is
 * unexpired, unspent and unrevoked, and takes the email from the invite row
 * rather than from the request so this cannot be used to create an account for
 * an arbitrary address.
 */
export async function POST(req: NextRequest) {
  const auth = getAuthConfig();
  if (!auth) {
    return NextResponse.json({ error: "auth not configured" }, { status: 503 });
  }

  let token = "";
  let name = "";
  let password = "";
  try {
    const body = await req.json();
    token = typeof body?.token === "string" ? body.token : "";
    name = typeof body?.name === "string" ? body.name : "";
    password = typeof body?.password === "string" ? body.password : "";
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  if (!token) return NextResponse.json({ error: "missing invite token" }, { status: 400 });

  const result = await acceptInvite({ token, name, password });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(
    SESSION_COOKIE,
    await createSessionToken(result.user.id, auth.secret),
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
    }
  );
  return res;
}
