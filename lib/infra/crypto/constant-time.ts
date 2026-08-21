// ---------------------------------------------------------------------------
// Constant-time comparison of two hex digests.
//
// This file deliberately has NO imports. Both callers run on the Edge runtime
// (proxy.ts pulls in lib/infra/auth.ts), so anything imported here is bundled
// into the proxy for the sake of one loop.
//
// It lives on its own because it was previously a private helper inside
// auth.ts, and password verification needs exactly the same primitive. A
// second copy is how one of them quietly grows an early `return false`.
// ---------------------------------------------------------------------------

/**
 * Compares two hex strings without leaking WHERE they differ through timing.
 *
 * The length check is not a timing leak worth worrying about here: every value
 * compared with this is a fixed-width digest, so a length mismatch already
 * means "not a valid digest" rather than "you got the first n characters
 * right".
 */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
