import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  MIN_PASSWORD_LENGTH,
  MIN_SECRET_LENGTH,
  describeAuthConfig,
  getAuthConfig,
} from "@/lib/infra/auth";

// Guards against the limits being lowered to something indefensible without a
// deliberate decision. 8 is the current floor for the password (see the note in
// lib/config/auth-policy.ts on why that is acceptable here); the signing key is
// machine-generated and has no usability reason to shrink.
const ABSOLUTE_MIN_PASSWORD = 8;
const ABSOLUTE_MIN_SECRET = 16;

// These tests exist because of a real incident: a deployment with both
// variables set showed "Set APP_PASSWORD and AUTH_SECRET" because the password
// was 10 characters. The gate was correct to refuse; the message was wrong, and
// the wrong message is what cost the debugging time.

const ORIGINAL = { ...process.env };
const GOOD_PASSWORD = "a-long-enough-password";
const GOOD_SECRET = "a-secret-of-at-least-16-chars";

beforeEach(() => {
  delete process.env.APP_PASSWORD;
  delete process.env.AUTH_SECRET;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, ORIGINAL);
});

describe("getAuthConfig - fail closed", () => {
  it("keeps the limits at or above the agreed floor", () => {
    // Not a style check. A single-character APP_PASSWORD would make the gate
    // decorative, and the login throttle is per-warm-instance rather than
    // global, so it cannot compensate.
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(ABSOLUTE_MIN_PASSWORD);
    expect(MIN_SECRET_LENGTH).toBeGreaterThanOrEqual(ABSOLUTE_MIN_SECRET);
  });

  it("returns null when nothing is set", () => {
    expect(getAuthConfig()).toBeNull();
  });

  it("returns null when the password is one character too short", () => {
    process.env.APP_PASSWORD = "x".repeat(MIN_PASSWORD_LENGTH - 1);
    process.env.AUTH_SECRET = GOOD_SECRET;
    expect(getAuthConfig()).toBeNull();
  });

  it("accepts a password of exactly the minimum length", () => {
    // Boundary: the check is `< MIN`, so exactly MIN must pass. An off-by-one
    // here locks the owner out of their own deployment.
    process.env.APP_PASSWORD = "x".repeat(MIN_PASSWORD_LENGTH);
    process.env.AUTH_SECRET = GOOD_SECRET;
    expect(getAuthConfig()).not.toBeNull();
  });

  it("accepts a secret of exactly the minimum length", () => {
    process.env.APP_PASSWORD = GOOD_PASSWORD;
    process.env.AUTH_SECRET = "y".repeat(MIN_SECRET_LENGTH);
    expect(getAuthConfig()).not.toBeNull();
  });

  it("returns null when the secret is too short even with a good password", () => {
    process.env.APP_PASSWORD = GOOD_PASSWORD;
    process.env.AUTH_SECRET = "y".repeat(MIN_SECRET_LENGTH - 1);
    expect(getAuthConfig()).toBeNull();
  });
});

describe("the two enforcement points agree", () => {
  it("uses the same limits in the Edge gate and in startup validation", async () => {
    // lib/infra/auth.ts (runtime gate, Edge) and lib/config/env.ts (startup
    // validation, Node) both enforce these. They used to hardcode their own
    // copies, so raising one would leave the other accepting shorter values —
    // the app would validate at boot and then serve 503 at the gate, which is
    // exactly the confusing failure this whole area already produced once.
    const policy = await import("@/lib/config/auth-policy");
    expect(MIN_PASSWORD_LENGTH).toBe(policy.MIN_PASSWORD_LENGTH);
    expect(MIN_SECRET_LENGTH).toBe(policy.MIN_SECRET_LENGTH);
  });

  it("rejects a password one under the limit at BOTH layers", async () => {
    const { getEnvSafe, resetEnvCache } = await import("@/lib/config/env");
    process.env.APP_PASSWORD = "x".repeat(MIN_PASSWORD_LENGTH - 1);
    process.env.AUTH_SECRET = GOOD_SECRET;
    resetEnvCache();

    expect(getAuthConfig()).toBeNull(); // Edge gate
    expect(getEnvSafe().ok).toBe(false); // startup validation
    resetEnvCache();
  });

  it("accepts a password exactly at the limit at BOTH layers", async () => {
    const { getEnvSafe, resetEnvCache } = await import("@/lib/config/env");
    process.env.APP_PASSWORD = "x".repeat(MIN_PASSWORD_LENGTH);
    process.env.AUTH_SECRET = GOOD_SECRET;
    resetEnvCache();

    expect(getAuthConfig()).not.toBeNull();
    expect(getEnvSafe().ok).toBe(true);
    resetEnvCache();
  });
});

describe("describeAuthConfig - says WHICH thing is wrong", () => {
  it("reports ok when both are valid", () => {
    process.env.APP_PASSWORD = GOOD_PASSWORD;
    process.env.AUTH_SECRET = GOOD_SECRET;
    expect(describeAuthConfig().ok).toBe(true);
  });

  it("distinguishes a MISSING password from a SHORT one", () => {
    // The whole point. "not set" and "set but 10 chars" are different problems
    // with different fixes, and telling someone to set a variable they have
    // already set sends them looking in the wrong place.
    process.env.AUTH_SECRET = GOOD_SECRET;
    const missing = describeAuthConfig();
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.problems).toContain("app_password_missing");

    process.env.APP_PASSWORD = "short";
    const tooShort = describeAuthConfig();
    expect(tooShort.ok).toBe(false);
    if (!tooShort.ok) {
      expect(tooShort.problems).toContain("app_password_too_short");
      expect(tooShort.problems).not.toContain("app_password_missing");
    }
  });

  it("reproduces the original incident: a set-but-too-short password", () => {
    // The incident was a 10-character password against a 12-character minimum.
    // Expressed relative to the constant rather than as literals, so lowering
    // the minimum (as we later did, to 8) cannot make this test silently pass
    // for the wrong reason — the case it guards is "set but under the bar",
    // whatever the bar currently is.
    const actualLength = MIN_PASSWORD_LENGTH - 2;
    process.env.APP_PASSWORD = "x".repeat(actualLength);
    process.env.AUTH_SECRET = GOOD_SECRET;
    const result = describeAuthConfig();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toEqual(["app_password_too_short"]);
      // The message must name the variable, say it IS set, and give both numbers.
      expect(result.message).toMatch(/APP_PASSWORD/);
      expect(result.message).toMatch(/is set but/);
      expect(result.message).toMatch(new RegExp(`\\b${actualLength}\\b`));
      expect(result.message).toMatch(new RegExp(`\\b${MIN_PASSWORD_LENGTH}\\b`));
    }
  });

  it("distinguishes a missing secret from a short one", () => {
    process.env.APP_PASSWORD = GOOD_PASSWORD;
    const missing = describeAuthConfig();
    if (!missing.ok) expect(missing.problems).toContain("auth_secret_missing");

    process.env.AUTH_SECRET = "tooshort";
    const short = describeAuthConfig();
    if (!short.ok) expect(short.problems).toContain("auth_secret_too_short");
  });

  it("reports BOTH problems at once rather than one at a time", () => {
    // Otherwise fixing the password just reveals the next error, which is the
    // slowest possible way to configure a deployment.
    process.env.APP_PASSWORD = "short";
    process.env.AUTH_SECRET = "alsoshort";
    const result = describeAuthConfig();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toHaveLength(2);
      expect(result.message).toMatch(/APP_PASSWORD/);
      expect(result.message).toMatch(/AUTH_SECRET/);
    }
  });

  it("never leaks the configured values", () => {
    const secretValue = "SUPERSECRETVALUE12345";
    process.env.APP_PASSWORD = "short";
    process.env.AUTH_SECRET = secretValue;
    const result = describeAuthConfig();
    if (!result.ok) {
      expect(result.message).not.toContain(secretValue);
      expect(result.message).not.toContain("short");
    }
  });

  it("agrees with getAuthConfig on every combination", () => {
    // The diagnostic must never disagree with the gate. A message saying
    // "everything is fine" while the gate serves 503 would be worse than the
    // bug it replaced.
    const cases: Array<[string | undefined, string | undefined]> = [
      [undefined, undefined],
      [GOOD_PASSWORD, undefined],
      [undefined, GOOD_SECRET],
      ["short", GOOD_SECRET],
      [GOOD_PASSWORD, "short"],
      [GOOD_PASSWORD, GOOD_SECRET],
      ["", ""],
    ];
    for (const [password, secret] of cases) {
      delete process.env.APP_PASSWORD;
      delete process.env.AUTH_SECRET;
      if (password !== undefined) process.env.APP_PASSWORD = password;
      if (secret !== undefined) process.env.AUTH_SECRET = secret;
      expect(describeAuthConfig().ok, `for ${password} / ${secret}`).toBe(
        getAuthConfig() !== null
      );
    }
  });
});
