import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/lib/config/env";
import {
  JOB_SOURCES,
  LEAD_SOURCES,
  type SourceDefinition,
} from "@/lib/infra/sources/registry";
import { fetchAllJobs, fetchAllLeads } from "@/lib/infra/sources";
import type { RawJob, RawLead } from "@/lib/domain/types";

// ---------------------------------------------------------------------------
// Env keys these tests own. They are cleared before every test and restored
// afterwards, so a developer who happens to have real Adzuna keys exported
// gets the same results as CI.
// ---------------------------------------------------------------------------
const OWNED_KEYS = [
  "ADZUNA_APP_ID",
  "ADZUNA_APP_KEY",
  "ENABLE_UPWORK_RSS",
  "ENABLE_LINKEDIN_ALERTS",
] as const;

let saved: Record<string, string | undefined> = {};

function setEnv(values: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // env.ts memoises, so the cache must be dropped after every mutation.
  resetEnvCache();
}

beforeEach(() => {
  saved = Object.fromEntries(OWNED_KEYS.map((k) => [k, process.env[k]]));
  setEnv(Object.fromEntries(OWNED_KEYS.map((k) => [k, undefined])));
});

afterEach(() => {
  setEnv(saved);
});

function byName<T>(sources: SourceDefinition<T>[], name: string) {
  const found = sources.find((s) => s.name === name);
  if (!found) throw new Error(`no source named "${name}" in the registry`);
  return found;
}

// ---------------------------------------------------------------------------

describe("source names", () => {
  // THIS IS THE REGRESSION TEST. Every name below is already written into the
  // `source` column of the jobs/leads tables and is half of the (source,
  // sourceId) dedupe key. Changing one orphans every existing row, which means
  // jobs already applied to reappear as new and get applied to a second time.
  // If this test fails because you renamed a source, the rename is the bug.
  it("matches the exact persisted list of job sources, in order", () => {
    expect(JOB_SOURCES.map((s) => s.name)).toEqual([
      "remoteok",
      "remotive",
      "arbeitnow",
      "wwr",
      "himalayas",
      "jobicy",
      "adzuna",
      "linkedin_alert",
    ]);
  });

  it("matches the exact persisted list of lead sources, in order", () => {
    expect(LEAD_SOURCES.map((s) => s.name)).toEqual([
      "arbeitnow_contract",
      "wwr_contract",
      "upwork_rss",
    ]);
  });

  it("has no duplicate names within either registry", () => {
    const jobNames = JOB_SOURCES.map((s) => s.name);
    const leadNames = LEAD_SOURCES.map((s) => s.name);
    expect(new Set(jobNames).size).toBe(jobNames.length);
    expect(new Set(leadNames).size).toBe(leadNames.length);
  });

  it("shares no name between the job and lead registries", () => {
    // A collision would make two different row shapes indistinguishable by
    // their `source` value.
    const jobNames = new Set(JOB_SOURCES.map((s) => s.name));
    const collisions = LEAD_SOURCES.map((s) => s.name).filter((n) =>
      jobNames.has(n)
    );
    expect(collisions).toEqual([]);
  });

  it("tags every definition with the kind of its registry", () => {
    expect(JOB_SOURCES.every((s) => s.kind === "job")).toBe(true);
    expect(LEAD_SOURCES.every((s) => s.kind === "lead")).toBe(true);
  });
});

describe("enabled()", () => {
  it("leaves the unconditional sources on with no env at all", () => {
    const unconditional = [
      "remoteok",
      "remotive",
      "arbeitnow",
      "wwr",
      "himalayas",
      "jobicy",
    ];
    for (const name of unconditional) {
      expect(byName(JOB_SOURCES, name).enabled(), name).toBe(true);
    }
    expect(byName(LEAD_SOURCES, "arbeitnow_contract").enabled()).toBe(true);
    expect(byName(LEAD_SOURCES, "wwr_contract").enabled()).toBe(true);
  });

  describe("adzuna", () => {
    const adzuna = () => byName(JOB_SOURCES, "adzuna");

    it("is disabled with a reason when neither key is set", () => {
      expect(adzuna().enabled()).toBe(false);
      const reason = adzuna().disabledReason?.();
      expect(reason).toBeTruthy();
      expect(reason).toContain("ADZUNA_APP_ID");
      expect(reason).toContain("ADZUNA_APP_KEY");
    });

    it("is disabled and names the missing half when only one key is set", () => {
      setEnv({ ADZUNA_APP_ID: "app-id" });
      expect(adzuna().enabled()).toBe(false);
      expect(adzuna().disabledReason?.()).toContain("ADZUNA_APP_KEY");
    });

    it("is enabled with no reason when both keys are set", () => {
      setEnv({ ADZUNA_APP_ID: "app-id", ADZUNA_APP_KEY: "app-key" });
      expect(adzuna().enabled()).toBe(true);
      expect(adzuna().disabledReason?.()).toBeUndefined();
    });
  });

  describe("upwork_rss", () => {
    const upwork = () => byName(LEAD_SOURCES, "upwork_rss");

    it("is disabled by default, with a reason naming the flag", () => {
      expect(upwork().enabled()).toBe(false);
      expect(upwork().disabledReason?.()).toContain("ENABLE_UPWORK_RSS");
    });

    it("is enabled when ENABLE_UPWORK_RSS is set", () => {
      setEnv({ ENABLE_UPWORK_RSS: "1" });
      expect(upwork().enabled()).toBe(true);
      expect(upwork().disabledReason?.()).toBeUndefined();
    });

    it("stays disabled for a falsey flag value", () => {
      setEnv({ ENABLE_UPWORK_RSS: "0" });
      expect(upwork().enabled()).toBe(false);
    });
  });

  describe("linkedin_alert", () => {
    const linkedin = () => byName(JOB_SOURCES, "linkedin_alert");

    it("is disabled by default, with a reason naming the flag", () => {
      expect(linkedin().enabled()).toBe(false);
      expect(linkedin().disabledReason?.()).toContain("ENABLE_LINKEDIN_ALERTS");
    });

    it("is enabled when ENABLE_LINKEDIN_ALERTS is set", () => {
      setEnv({ ENABLE_LINKEDIN_ALERTS: "1" });
      expect(linkedin().enabled()).toBe(true);
      expect(linkedin().disabledReason?.()).toBeUndefined();
    });
  });

  it("re-reads env on every call rather than capturing it at import time", () => {
    const adzuna = byName(JOB_SOURCES, "adzuna");
    expect(adzuna.enabled()).toBe(false);
    setEnv({ ADZUNA_APP_ID: "a", ADZUNA_APP_KEY: "b" });
    expect(adzuna.enabled()).toBe(true);
    setEnv({ ADZUNA_APP_ID: undefined, ADZUNA_APP_KEY: undefined });
    expect(adzuna.enabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fan-out behaviour, driven entirely by injected fakes - no network.
// ---------------------------------------------------------------------------

function job(id: string, source: string): RawJob {
  return {
    source,
    sourceId: id,
    title: `Job ${id}`,
    company: "Acme",
    url: `https://example.test/${id}`,
  };
}

function lead(id: string, source: string): RawLead {
  return {
    source,
    sourceId: id,
    title: `Lead ${id}`,
    url: `https://example.test/${id}`,
  };
}

function fakeJobSource(
  name: string,
  fetch: () => Promise<RawJob[]>,
  extra: Partial<SourceDefinition<RawJob>> = {}
): SourceDefinition<RawJob> {
  return { name, kind: "job", fetch, enabled: () => true, ...extra };
}

describe("fetchAllJobs", () => {
  it("keeps going when one source throws, and records the error", async () => {
    const result = await fetchAllJobs([
      fakeJobSource("good_a", async () => [job("1", "good_a")]),
      fakeJobSource("broken", async () => {
        throw new Error("upstream 503");
      }),
      fakeJobSource("good_b", async () => [job("2", "good_b")]),
    ]);

    expect(result.jobs.map((j) => j.sourceId).sort()).toEqual(["1", "2"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("broken");
    expect(result.errors[0]).toContain("upstream 503");
    expect(result.skipped).toEqual([]);
  });

  it("survives a source that rejects with a non-Error value", async () => {
    const result = await fetchAllJobs([
      fakeJobSource("good", async () => [job("1", "good")]),
      fakeJobSource("weird", async () => {
        throw "just a string";
      }),
    ]);

    expect(result.jobs).toHaveLength(1);
    expect(result.errors[0]).toContain("just a string");
  });

  it("survives a source that throws synchronously before returning a promise", async () => {
    const result = await fetchAllJobs([
      fakeJobSource("good", async () => [job("1", "good")]),
      // Not `async` - throws during the call itself, not inside a promise.
      fakeJobSource("sync_throw", (() => {
        throw new Error("blew up immediately");
      }) as () => Promise<RawJob[]>),
    ]);

    expect(result.jobs).toHaveLength(1);
    expect(result.errors[0]).toContain("blew up immediately");
  });

  it("skips disabled sources and reports the name with its reason", async () => {
    const result = await fetchAllJobs([
      fakeJobSource("on", async () => [job("1", "on")]),
      fakeJobSource("off", async () => [job("2", "off")], {
        enabled: () => false,
        disabledReason: () => "set SOME_FLAG=1 to enable",
      }),
    ]);

    expect(result.jobs.map((j) => j.sourceId)).toEqual(["1"]);
    expect(result.skipped).toEqual(["off: set SOME_FLAG=1 to enable"]);
    expect(result.errors).toEqual([]);
  });

  it("never calls fetch on a disabled source", async () => {
    let called = false;
    const result = await fetchAllJobs([
      fakeJobSource(
        "off",
        async () => {
          called = true;
          return [];
        },
        { enabled: () => false }
      ),
    ]);

    expect(called).toBe(false);
    // No disabledReason supplied - the bare name is still reported.
    expect(result.skipped).toEqual(["off"]);
  });

  it("reports an error instead of rejecting when enabled() itself throws", async () => {
    // enabled() reads getEnv(), which throws on a malformed configuration. A
    // bad env must not be able to abort the whole run.
    const result = await fetchAllJobs([
      fakeJobSource("good", async () => [job("1", "good")]),
      fakeJobSource("bad_env", async () => [job("2", "bad_env")], {
        enabled: () => {
          throw new Error("Invalid environment configuration");
        },
      }),
    ]);

    expect(result.jobs).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("bad_env");
  });

  it("returns empty results, not a rejection, when every source fails", async () => {
    const result = await fetchAllJobs([
      fakeJobSource("a", async () => {
        throw new Error("a down");
      }),
      fakeJobSource("b", async () => {
        throw new Error("b down");
      }),
    ]);

    expect(result.jobs).toEqual([]);
    expect(result.errors).toHaveLength(2);
  });
});

describe("fetchAllLeads", () => {
  it("applies the same fail-safe and skip reporting", async () => {
    const result = await fetchAllLeads([
      {
        name: "ok",
        kind: "lead",
        enabled: () => true,
        fetch: async () => [lead("1", "ok")],
      },
      {
        name: "broken",
        kind: "lead",
        enabled: () => true,
        fetch: async () => {
          throw new Error("feed gone");
        },
      },
      {
        name: "off",
        kind: "lead",
        enabled: () => false,
        disabledReason: () => "experimental",
        fetch: async () => [lead("2", "off")],
      },
    ]);

    expect(result.leads.map((l) => l.sourceId)).toEqual(["1"]);
    expect(result.errors[0]).toContain("broken");
    expect(result.skipped).toEqual(["off: experimental"]);
  });
});

describe("the real registries, run with everything disabled", () => {
  it("reports adzuna, linkedin_alert and upwork_rss as skipped without fetching", async () => {
    // Only the disabled sources are exercised here: the always-on ones are
    // filtered out before any fetch happens, so nothing hits the network.
    const jobs = await fetchAllJobs(
      JOB_SOURCES.filter((s) => !s.enabled())
    );
    expect(jobs.jobs).toEqual([]);
    expect(jobs.skipped.map((s) => s.split(":")[0]).sort()).toEqual([
      "adzuna",
      "linkedin_alert",
    ]);

    const leads = await fetchAllLeads(LEAD_SOURCES.filter((s) => !s.enabled()));
    expect(leads.leads).toEqual([]);
    expect(leads.skipped.map((s) => s.split(":")[0])).toEqual(["upwork_rss"]);
  });
});
