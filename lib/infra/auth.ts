/**
 * Single-user auth for this deployment.
 *
 * There is no user table and no signup: one password (APP_PASSWORD) unlocks the
 * whole app, and a signed cookie keeps you logged in. Everything here runs on
 * the Edge runtime (proxy.ts) as well as Node, so it uses Web Crypto only -
 * no `node:crypto` imports.
 */

import {
  MIN_PASSWORD_LENGTH,
  MIN_SECRET_LENGTH,
} from "@/lib/config/auth-policy";

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

/** Length-independent, constant-time-ish comparison of two hex digests. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Compares a submitted password against the configured one without leaking
 * length or content through timing: both sides are HMAC'd first (the standard
 * double-HMAC trick) and only the fixed-length digests are compared.
 */
export async function passwordMatches(
  submitted: string,
  { password, secret }: AuthConfig
): Promise<boolean> {
  const [a, b] = await Promise.all([
    hmacHex(submitted, secret),
    hmacHex(password, secret),
  ]);
  return safeEqual(a, b);
}

/** Token format: `<expiryEpochSeconds>.<hmac>`. Stateless - no server session store. */
export async function createSessionToken(secret: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS;
  const sig = await hmacHex(String(exp), secret);
  return `${exp}.${sig}`;
}

export async function verifySessionToken(
  token: string | undefined,
  secret: string
): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(exp)) return false;
  if (Number(exp) <= Math.floor(Date.now() / 1000)) return false;
  return safeEqual(sig, await hmacHex(exp, secret));
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
