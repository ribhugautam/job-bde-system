// ---------------------------------------------------------------------------
// Credential length policy. The single source of truth for both enforcement
// points.
//
// Two places check these, and they must never disagree:
//   - lib/infra/auth.ts   the runtime gate in proxy.ts (Edge runtime)
//   - lib/config/env.ts   startup validation for the Node/server side
//
// They previously each hardcoded their own number, which is a silent-drift bug
// waiting to happen: raise one and the other keeps letting a shorter value
// through, so the app would validate at startup and then 503 at the gate.
//
// This file deliberately has NO imports. lib/infra/auth.ts runs on the Edge
// runtime, so pulling zod (or anything else) in through here would bloat the
// proxy bundle for the sake of two integers.
// ---------------------------------------------------------------------------

/**
 * Minimum length for APP_PASSWORD.
 *
 * The login route (app/api/auth/login/route.ts) throttles at 10 attempts per
 * minute per IP, but that counter is per warm serverless instance rather than
 * global — so it is a speed bump, not a real rate limiter. At this length a
 * RANDOM password is still far out of brute-force reach; a dictionary word of
 * the same length is not. Choose accordingly.
 */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Minimum length for AUTH_SECRET, the HMAC key signing the session cookie.
 *
 * Unlike the password this is never typed by a human — the setup instructions
 * generate it with `openssl rand -hex 32` — so there is no usability reason to
 * lower it, and a weak signing key would let a session token be forged outright
 * rather than merely guessed.
 */
export const MIN_SECRET_LENGTH = 16;
