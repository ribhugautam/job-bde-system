/**
 * Single-user auth for this deployment.
 *
 * There is no user table and no signup: one password (APP_PASSWORD) unlocks the
 * whole app, and a signed cookie keeps you logged in. Everything here runs on
 * the Edge runtime (proxy.ts) as well as Node, so it uses Web Crypto only -
 * no `node:crypto` imports.
 */

export const SESSION_COOKIE = "bde_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

/**
 * Minimum length we will accept for APP_PASSWORD. This exists so a placeholder
 * or a three-character password can never reach production by accident - the
 * gate fails closed instead of quietly accepting something guessable.
 */
export const MIN_PASSWORD_LENGTH = 12;

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
  if (!secret || secret.length < 16) return null;
  return { password, secret };
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
