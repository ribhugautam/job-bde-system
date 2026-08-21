import { describe, expect, it } from "vitest";
import {
  PBKDF2_ITERATIONS,
  hashPassword,
  needsRehash,
  randomHex,
  verifyPassword,
} from "@/lib/infra/crypto/password";
import { safeEqualHex } from "@/lib/infra/crypto/constant-time";

// PBKDF2 at 600k iterations is deliberately slow — that is the entire point of
// a password KDF. A handful of derivations per test file is fine; loops are
// not, so each case here hashes at most twice.
const SLOW = 30_000;

describe("hashPassword / verifyPassword", () => {
  it("round-trips a correct password", { timeout: SLOW }, async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
  });

  it("rejects a wrong password", { timeout: SLOW }, async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("Correct horse battery staple", stored)).toBe(false);
  });

  it("produces a different hash for the same password each time", { timeout: SLOW }, async () => {
    // Distinct salts. Without this, identical passwords are visibly identical
    // in the table, which hands an attacker a free frequency analysis.
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
  });

  it("encodes algorithm, iterations and salt alongside the digest", { timeout: SLOW }, async () => {
    const stored = await hashPassword("whatever-you-like");
    const [algorithm, iterations, salt, digest] = stored.split("$");
    expect(algorithm).toBe("pbkdf2-sha256");
    expect(Number(iterations)).toBe(PBKDF2_ITERATIONS);
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it(
    "derives using the iteration count IN THE HASH, not today's constant",
    { timeout: SLOW },
    async () => {
      // This is what makes the cost factor upgradeable: raising
      // PBKDF2_ITERATIONS must never invalidate hashes already in the table,
      // because verification reads the count out of the stored string.
      //
      // Proved by tampering: take a valid hash and change ONLY its iteration
      // count. If the count were ignored in favour of the module constant,
      // verification would still succeed. It must not.
      const stored = await hashPassword("upgradeable");
      expect(await verifyPassword("upgradeable", stored)).toBe(true);

      const [algorithm, iterations, salt, digest] = stored.split("$");
      const tampered = [algorithm, String(Number(iterations) - 1), salt, digest].join("$");
      expect(await verifyPassword("upgradeable", tampered)).toBe(false);
    }
  );
});

describe("verifyPassword on malformed stored values", () => {
  // Every one of these must return false rather than throw. A crash here would
  // be an availability bug reachable by anyone able to write a bad row, and it
  // would leak "this user exists but their row is broken".
  const bad = [
    "",
    "not-a-hash",
    "pbkdf2-sha256$600000$abcd", // too few segments
    "pbkdf2-sha256$600000$abcd$ef$gh", // too many
    "scrypt$600000$abcd$ef", // unknown algorithm
    "pbkdf2-sha256$notanumber$abcd$ef",
    "pbkdf2-sha256$600000$xyz$ef", // non-hex salt
    "pbkdf2-sha256$600000$abcd$zz", // non-hex digest
    "pbkdf2-sha256$0$abcd$ef", // zero iterations
    "pbkdf2-sha256$999999999$abcd$ef", // absurd iterations: a DoS vector
  ];

  for (const stored of bad) {
    it(`returns false for ${JSON.stringify(stored)}`, async () => {
      expect(await verifyPassword("anything", stored)).toBe(false);
    });
  }
});

describe("needsRehash", () => {
  it("is false for a hash at the current cost factor", { timeout: SLOW }, async () => {
    expect(needsRehash(await hashPassword("x-password"))).toBe(false);
  });

  it("is true for a weaker cost factor", () => {
    expect(needsRehash("pbkdf2-sha256$1000$abcd$ef")).toBe(true);
  });

  it("is true for anything unparseable, so a bad row gets replaced", () => {
    expect(needsRehash("garbage")).toBe(true);
    expect(needsRehash("scrypt$600000$abcd$ef")).toBe(true);
  });
});

describe("randomHex", () => {
  it("returns the requested number of bytes as hex", () => {
    expect(randomHex(16)).toMatch(/^[0-9a-f]{32}$/);
    expect(randomHex(32)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 50 }, () => randomHex(16)));
    expect(seen.size).toBe(50);
  });
});

describe("safeEqualHex", () => {
  it("matches identical strings and rejects any difference", () => {
    expect(safeEqualHex("abc123", "abc123")).toBe(true);
    expect(safeEqualHex("abc123", "abc124")).toBe(false);
    expect(safeEqualHex("abc123", "abc12")).toBe(false);
    expect(safeEqualHex("", "")).toBe(true);
  });
});
