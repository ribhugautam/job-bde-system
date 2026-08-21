import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  createSessionToken,
  getAuthConfig,
} from "@/lib/infra/auth";
import { authenticate } from "@/lib/infra/db/users";

export const dynamic = "force-dynamic";

/**
 * Crude per-instance throttle. Serverless means this map is per warm instance,
 * not global - it is a speed bump against a script hammering one instance, not
 * a real rate limiter.
 *
 * Keyed on IP + email rather than IP alone. With real accounts, one office
 * behind a single NAT address shares an IP, and an IP-only counter would let
 * one colleague's typos lock out everyone else in the building.
 */
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, { count: number; resetAt: number }>();

function throttled(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now > entry.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
}

export async function POST(req: NextRequest) {
  const auth = getAuthConfig();
  if (!auth) {
    return NextResponse.json({ error: "auth not configured" }, { status: 503 });
  }

  let email = "";
  let password = "";
  try {
    const body = await req.json();
    email = typeof body?.email === "string" ? body.email : "";
    password = typeof body?.password === "string" ? body.password : "";
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  if (throttled(`${ip}:${email.trim().toLowerCase()}`)) {
    return NextResponse.json(
      { error: "too many attempts, wait a minute" },
      { status: 429 }
    );
  }

  const user = await authenticate(email, password);
  if (!user) {
    // ONE message for "no such account", "wrong password" and "deactivated".
    // Splitting them would turn this form into an account-existence oracle,
    // and telling someone they have been deactivated is not this screen's job.
    return NextResponse.json(
      { error: "incorrect email or password" },
      { status: 401 }
    );
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await createSessionToken(user.id, auth.secret), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return res;
}
