import { safeEqualHex } from "./constant-time";

// ---------------------------------------------------------------------------
// Password hashing for the user table.
//
// PBKDF2-SHA256 via Web Crypto, NOT bcrypt/argon2. This is a deliberate
// constraint, not a shortcut: lib/infra/auth.ts is bundled into proxy.ts and
// runs on the Edge runtime, and this module sits next to it in the same auth
// surface. A native dependency would split the auth code into "the half that
// can run on Edge" and "the half that cannot", which is exactly the kind of
// seam an authorization bug hides in. PBKDF2 is the strongest KDF the Web
// Crypto API actually offers.
//
// Verification runs in the login route (Node runtime), never on the Edge, so
// the iteration count below is not paying an Edge CPU budget.
// ---------------------------------------------------------------------------

/**
 * OWASP's current floor for PBKDF2-SHA256 (2023 guidance).
 *
 * This number is STORED IN EVERY HASH rather than being read from here at
 * verification time — see the encoding note below. Raising it therefore costs
 * nothing and invalidates nothing: existing users keep verifying at the count
 * their hash records, and re-hash at the new one next time they set a password.
 */
export const PBKDF2_ITERATIONS = 600_000;

const ALGORITHM = "pbkdf2-sha256";
const SALT_BYTES = 16;
const KEY_BITS = 256;

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Cryptographically random hex string of `bytes` bytes. */
export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

async function derive(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    key,
    KEY_BITS
  );
  return toHex(new Uint8Array(bits));
}

/**
 * Hashes a password into ONE self-describing string:
 *
 *   pbkdf2-sha256$<iterations>$<saltHex>$<hashHex>
 *
 * Modelled on the PHC string format, and stored in a single column rather than
 * split across `password_hash` + `password_salt` + an implicit iteration count.
 * The parameters travel WITH the hash, which is what makes the cost factor
 * upgradeable: bump PBKDF2_ITERATIONS and every existing hash still verifies,
 * because verification reads the count out of the stored string instead of
 * assuming today's constant. Split columns cannot do that without a migration
 * that has no way to recompute the hashes it would need to change.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = fromHex(randomHex(SALT_BYTES));
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return `${ALGORITHM}$${PBKDF2_ITERATIONS}$${toHex(salt)}$${hash}`;
}

/**
 * Verifies a password against a stored hash string.
 *
 * Returns false — never throws — for a malformed or unknown-algorithm stored
 * value. A corrupted row must fail closed as "wrong password", not 500 the
 * login route: a crash here would be an availability bug reachable by anyone
 * able to write a bad row, and it would leak the difference between "no such
 * user" and "user exists but their row is broken".
 */
export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4) return false;

  const [algorithm, iterationsRaw, saltHex, expected] = parts;
  if (algorithm !== ALGORITHM) return false;
  if (!/^\d+$/.test(iterationsRaw)) return false;
  if (!/^[0-9a-f]+$/.test(saltHex) || saltHex.length % 2 !== 0) return false;
  if (!/^[0-9a-f]+$/.test(expected)) return false;

  const iterations = Number(iterationsRaw);
  // An absurd iteration count in a stored row would otherwise let a bad write
  // turn one login attempt into a denial of service.
  if (iterations < 1 || iterations > 10_000_000) return false;

  const actual = await derive(password, fromHex(saltHex), iterations);
  return safeEqualHex(actual, expected);
}

/**
 * True when a stored hash was produced with weaker parameters than we now use,
 * so the caller can transparently re-hash on the next successful login.
 */
export function needsRehash(stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 4) return true;
  if (parts[0] !== ALGORITHM) return true;
  const iterations = Number(parts[1]);
  return !Number.isFinite(iterations) || iterations < PBKDF2_ITERATIONS;
}
