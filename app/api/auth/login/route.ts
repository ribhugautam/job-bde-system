import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  createSessionToken,
  getAuthConfig,
  passwordMatches,
} from "@/lib/infra/auth";

export const dynamic = "force-dynamic";

/**
 * Crude per-instance throttle. Serverless means this map is per warm instance,
 * not global - it is a speed bump against a script hammering one instance, not
 * a real rate limiter. Good enough for a single-user tool behind a long password.
 */
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, { count: number; resetAt: number }>();

function throttled(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
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

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  if (throttled(ip)) {
    return NextResponse.json(
      { error: "too many attempts, wait a minute" },
      { status: 429 }
    );
  }

  let password = "";
  try {
    const body = await req.json();
    password = typeof body?.password === "string" ? body.password : "";
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  if (!(await passwordMatches(password, auth))) {
    return NextResponse.json({ error: "incorrect password" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await createSessionToken(auth.secret), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return res;
}
