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

  it("applies documented defaults", () => {
    const env = getEnv();
    expect(env.MATCH_THRESHOLD).toBe(40);
    expect(env.FOLLOWUP_FIRST_DAYS).toBe(4);
    expect(env.FOLLOWUP_FINAL_DAYS).toBe(10);
    expect(env.OUTREACH_DAILY_CAP).toBe(10);
    expect(env.WORKER_BATCH_SIZE).toBe(25);
  });

  it("defaults DRY_RUN to false so an explicit opt-in is required to go live... and to stay safe", () => {
    // DRY_RUN defaults off, but every send path also requires real credentials,
    // so an unconfigured deployment still cannot email anyone.
    expect(getEnv().DRY_RUN).toBe(false);
  });
});

describe("boolean coercion", () => {
  it("accepts the documented truthy spellings, not just '1'", () => {
    // The bug this prevents: a source registry that reads a real boolean while
    // a fetcher separately checks `=== "1"`. ENABLE_X=true then enables the
    // source and silently yields nothing.
    for (const value of ["1", "true", "TRUE", "yes", "on", " true "]) {
      setEnv({ ENABLE_LINKEDIN_ALERTS: value });
      expect(getEnv().ENABLE_LINKEDIN_ALERTS, `for ${JSON.stringify(value)}`).toBe(true);
    }
  });

  it("treats anything else as false", () => {
    for (const value of ["0", "false", "no", "off", "", "banana"]) {
      setEnv({ ENABLE_LINKEDIN_ALERTS: value });
      expect(getEnv().ENABLE_LINKEDIN_ALERTS, `for ${JSON.stringify(value)}`).toBe(false);
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

  it("rejects a final follow-up scheduled before the first", () => {
    // Otherwise both fire in the same run and one person gets two emails at once.
    setEnv({ FOLLOWUP_FIRST_DAYS: "10", FOLLOWUP_FINAL_DAYS: "4" });
    const result = getEnvSafe();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join()).toMatch(/FOLLOWUP_FINAL_DAYS/);
  });

  it("rejects equal follow-up offsets", () => {
    setEnv({ FOLLOWUP_FIRST_DAYS: "5", FOLLOWUP_FINAL_DAYS: "5" });
    expect(getEnvSafe().ok).toBe(false);
  });

  it("rejects a short APP_PASSWORD", () => {
    setEnv({ APP_PASSWORD: "short" });
    const result = getEnvSafe();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join()).toMatch(/APP_PASSWORD/);
  });

  it("rejects an out-of-range threshold", () => {
    setEnv({ MATCH_THRESHOLD: "500" });
    expect(getEnvSafe().ok).toBe(false);
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
    setEnv({ APP_PASSWORD: "short", MATCH_THRESHOLD: "999" });
    expect(() => getEnv()).toThrow(/APP_PASSWORD/);
    expect(() => getEnv()).toThrow(/MATCH_THRESHOLD/);
  });

  it("memoises until the cache is reset", () => {
    const first = getEnv();
    process.env.MATCH_THRESHOLD = "77";
    expect(getEnv()).toBe(first); // same object, stale by design
    resetEnvCache();
    expect(getEnv().MATCH_THRESHOLD).toBe(77);
  });
});
