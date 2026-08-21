import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getEnv, getEnvSafe, resetEnvCache } from "@/lib/config/env";

// env.ts memoises, so every test starts from a clean slate.
const ORIGINAL = { ...process.env };

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
}

beforeEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  resetEnvCache();
});

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, ORIGINAL);
  resetEnvCache();
});

describe("defaults", () => {
  it("falls back to a local SQLite file when no database is configured", () => {
    // This is what makes `npm run dev` work with an empty .env.
    const env = getEnv();
    expect(env.databaseUrl).toBe("file:./local.db");
  });

  // Operational defaults (MATCH_THRESHOLD, FOLLOWUP_*, WORKER_*, ...) moved to
  // the runtime settings store and are covered in tests/config/settings.test.ts.
  // This file now only guards what is genuinely secret or infrastructural.

  it("defaults DRY_RUN to false so an explicit opt-in is required to go live... and to stay safe", () => {
    // DRY_RUN defaults off, but every send path also requires real credentials,
    // so an unconfigured deployment still cannot email anyone.
    expect(getEnv().DRY_RUN).toBe(false);
  });
});

describe("boolean coercion", () => {
  // DRY_RUN is the only boolean left in env, and it is the one that matters
  // most: it is the deploy-level kill switch, and a spelling it fails to
  // recognise reads as "sending is enabled".
  it("accepts the documented truthy spellings, not just '1'", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on", " true "]) {
      setEnv({ DRY_RUN: value });
      expect(getEnv().DRY_RUN, `for ${JSON.stringify(value)}`).toBe(true);
    }
  });

  it("treats anything else as false", () => {
    for (const value of ["0", "false", "no", "off", "", "banana"]) {
      setEnv({ DRY_RUN: value });
      expect(getEnv().DRY_RUN, `for ${JSON.stringify(value)}`).toBe(false);
    }
  });
});

describe("validation", () => {
  it("rejects a remote database URL with no auth token", () => {
    // Without this the failure surfaces later as an opaque libSQL error.
    setEnv({ TURSO_DATABASE_URL: "libsql://db.turso.io" });
    const result = getEnvSafe();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join()).toMatch(/TURSO_AUTH_TOKEN/);
    }
  });

  it("accepts a remote database URL with a token", () => {
    setEnv({
      TURSO_DATABASE_URL: "libsql://db.turso.io",
      TURSO_AUTH_TOKEN: "token",
    });
    expect(getEnvSafe().ok).toBe(true);
  });

  // The follow-up ordering rule moved with the settings it validates; it is now
  // a save-time message rather than a startup crash. See settings.test.ts.

  it("rejects a short APP_PASSWORD", () => {
    setEnv({ APP_PASSWORD: "short" });
    const result = getEnvSafe();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join()).toMatch(/APP_PASSWORD/);
  });

  it("rejects a short ENCRYPTION_KEY", () => {
    // Too short to be a real generated key, so almost certainly a placeholder.
    setEnv({ ENCRYPTION_KEY: "not-long-enough" });
    const result = getEnvSafe();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join()).toMatch(/ENCRYPTION_KEY/);
  });
});

describe("authConfigured", () => {
  it("is false unless both the password and the secret are present", () => {
    // proxy.ts serves 503 on this, so it must never be true by halves.
    expect(getEnv().authConfigured).toBe(false);

    setEnv({ APP_PASSWORD: "a-long-enough-password" });
    expect(getEnv().authConfigured).toBe(false);

    setEnv({ AUTH_SECRET: "a-long-enough-secret-value" });
    expect(getEnv().authConfigured).toBe(true);
  });
});

describe("accessor contract", () => {
  it("getEnvSafe never throws on a bad configuration", () => {
    setEnv({ APP_PASSWORD: "short" });
    expect(() => getEnvSafe()).not.toThrow();
  });

  it("getEnv throws, naming every bad key at once", () => {
    setEnv({ APP_PASSWORD: "short", ENCRYPTION_KEY: "tiny" });
    expect(() => getEnv()).toThrow(/APP_PASSWORD/);
    expect(() => getEnv()).toThrow(/ENCRYPTION_KEY/);
  });

  it("memoises until the cache is reset", () => {
    const first = getEnv();
    process.env.CRON_SECRET = "a-new-secret";
    expect(getEnv()).toBe(first); // same object, stale by design
    resetEnvCache();
    expect(getEnv().CRON_SECRET).toBe("a-new-secret");
  });
});
