/**
 * The cryptographic half of auth: session tokens and the AUTH_SECRET/
 * APP_PASSWORD configuration gate.
 *
 * Everything here runs on the Edge runtime (proxy.ts) as well as Node, so it
 * uses Web Crypto only — no `node:crypto` imports, and nothing that reaches the
 * database.
 *
 * THE SPLIT THIS FILE SITS ON, because getting it wrong is how authorization
 * bugs happen:
 *
 *   this file  — "is this a genuine, unexpired token we issued, and whose id
 *                 does it carry?" Answerable on the Edge with no I/O.
 *
 *   session.ts — "is that user real, and are they still allowed in?" Needs the
 *                 database, so it cannot live here, and it is the ONLY thing
 *                 that may be treated as proof of identity.
 *
 * Accounts themselves live in the `users` table; passwords are hashed in
 * lib/infra/crypto/password.ts. APP_PASSWORD is legacy and now seeds only the
 * first admin account.
 */

import {
  MIN_PASSWORD_LENGTH,
  MIN_SECRET_LENGTH,
} from "@/lib/config/auth-policy";
import { safeEqualHex } from "@/lib/infra/crypto/constant-time";

export const SESSION_COOKIE = "bde_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

// Re-exported so existing importers of these constants keep working, and so a
// reader of the gate can see the limits without chasing a second file. The
// values themselves live in lib/config/auth-policy.ts because startup
// validation in lib/config/env.ts enforces the same two numbers, and the two
// checks drifting apart is a silent lockout.
export { MIN_PASSWORD_LENGTH, MIN_SECRET_LENGTH };

const encoder = new TextEncoder();

export type AuthConfig = { password: string; secret: string };

/**
 * Reads and validates the two env vars the gate depends on.
 * Returns null when auth is not configured correctly - callers MUST treat that
 * as "deny everything", never as "allow everything".
 */
export function getAuthConfig(): AuthConfig | null {
  const password = process.env.APP_PASSWORD;
  const secret = process.env.AUTH_SECRET;
  if (!password || password.length < MIN_PASSWORD_LENGTH) return null;
  if (!secret || secret.length < MIN_SECRET_LENGTH) return null;
  return { password, secret };
}

export type AuthConfigProblem =
  | "app_password_missing"
  | "app_password_too_short"
  | "auth_secret_missing"
  | "auth_secret_too_short";

export type AuthConfigReport =
  | { ok: true }
  | { ok: false; problems: AuthConfigProblem[]; message: string };

/**
 * Why auth is not configured, in words an operator can act on.
 *
 * This exists because of a real incident. A deployment with BOTH variables set
 * served "Set APP_PASSWORD and AUTH_SECRET" - because the password was ten
 * characters. The gate was right to refuse; the message told the operator to do
 * something they had already done, and sent them looking in the wrong place on
 * both localhost and production.
 *
 * On disclosure: this reports that a variable is set-but-too-short, and the
 * length it needs to be. It never reports the value. The minimum lengths are
 * already published in .env.example and the README, and while this message is
 * reachable the app serves 503 to everyone and protects nothing - so the only
 * thing revealed is a misconfiguration that stops being true the moment it is
 * fixed. That is worth trading for an operator being able to read the actual
 * cause off the screen.
 *
 * MUST stay consistent with getAuthConfig(): a report of `ok` while the gate
 * returns null would be worse than the bug this replaced. A test asserts they
 * agree across every combination.
 */
export function describeAuthConfig(): AuthConfigReport {
  const password = process.env.APP_PASSWORD;
  const secret = process.env.AUTH_SECRET;

  const problems: AuthConfigProblem[] = [];
  const details: string[] = [];

  if (!password) {
    problems.push("app_password_missing");
    details.push(
      `APP_PASSWORD is not set. It must be at least ${MIN_PASSWORD_LENGTH} characters.`
    );
  } else if (password.length < MIN_PASSWORD_LENGTH) {
    problems.push("app_password_too_short");
    details.push(
      `APP_PASSWORD is set but only ${password.length} characters long; ` +
        `the minimum is ${MIN_PASSWORD_LENGTH}.`
    );
  }

  if (!secret) {
    problems.push("auth_secret_missing");
    details.push(
      `AUTH_SECRET is not set. Generate one with: openssl rand -hex 32`
    );
  } else if (secret.length < MIN_SECRET_LENGTH) {
    problems.push("auth_secret_too_short");
    details.push(
      `AUTH_SECRET is set but only ${secret.length} characters long; ` +
        `the minimum is ${MIN_SECRET_LENGTH}. Generate one with: openssl rand -hex 32`
    );
  }

  if (problems.length === 0) return { ok: true };
  return { ok: false, problems, message: details.join(" ") };
}

async function hmacHex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compares a submitted password against the configured one without leaking
 * length or content through timing: both sides are HMAC'd first (the standard
 * double-HMAC trick) and only the fixed-length digests are compared.
 *
 * LEGACY. This checks the single shared APP_PASSWORD, which is no longer how
 * anyone signs in — real accounts live in the `users` table and verify through
 * lib/infra/crypto/password.ts. It survives for exactly one purpose: seeding
 * the first admin account during migration, so the operator is not locked out
 * of their own deployment at the moment accounts are introduced. Nothing else
 * should call it.
 */
export async function passwordMatches(
  submitted: string,
  { password, secret }: AuthConfig
): Promise<boolean> {
  const [a, b] = await Promise.all([
    hmacHex(submitted, secret),
    hmacHex(password, secret),
  ]);
  return safeEqualHex(a, b);
}

/** What a valid session cookie asserts. */
export type SessionClaims = { userId: number };

/**
 * Token format: `<userId>.<expiryEpochSeconds>.<hmac>`. Stateless — no server
 * session store, which is what lets the Edge gate in proxy.ts verify a session
 * without a database round trip on every request.
 *
 * The previous format was `<exp>.<hmac>` with no identity in it. Tokens in that
 * shape have two segments instead of three and are simply rejected, so everyone
 * signs in once after this ships. That is the correct trade: silently accepting
 * an identity-less token would mean deciding, somewhere downstream, which user
 * it meant.
 *
 * WHAT THIS DOES NOT PROVE: that the user still exists, or is still active. The
 * signature is checked without touching the database, so a deactivated user's
 * cookie stays cryptographically valid until it expires. getSessionUser() in
 * lib/infra/session.ts is the authority on live identity, and every page and
 * route must go through it. This function answers "is this a genuine token we
 * issued?" — nothing more.
 */
export async function createSessionToken(
  userId: number,
  secret: string
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS;
  const payload = `${userId}.${exp}`;
  const sig = await hmacHex(payload, secret);
  return `${payload}.${sig}`;
}

/** Returns the claims a valid token carries, or null. Never throws. */
export async function verifySessionToken(
  token: string | undefined,
  secret: string
): Promise<SessionClaims | null> {
  if (!token) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [userIdRaw, exp, sig] = parts;
  if (!/^\d+$/.test(userIdRaw) || !/^\d+$/.test(exp)) return null;
  if (Number(exp) <= Math.floor(Date.now() / 1000)) return null;

  const expected = await hmacHex(`${userIdRaw}.${exp}`, secret);
  if (!safeEqualHex(sig, expected)) return null;

  const userId = Number(userIdRaw);
  // A non-positive or non-integral id cannot name a row, and letting one
  // through would push a nonsense value into every downstream query.
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;

  return { userId };
}

/**
 * Only allow redirects back to a path on this site. Without this check,
 * /login?next=https://evil.example turns the login page into an open redirect.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next) return "/dashboard";
  if (!next.startsWith("/")) return "/dashboard";
  if (next.startsWith("//")) return "/dashboard"; // protocol-relative URL
  return next;
}
