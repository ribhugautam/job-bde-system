import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/lib/config/env";
import { defaultSettings, type Settings } from "@/lib/config/settings";
import {
  JOB_SOURCES,
  LEAD_SOURCES,
  type SourceDefinition,
} from "@/lib/infra/sources/registry";
import { fetchAllJobs, fetchAllLeads } from "@/lib/infra/sources";
import type { RawJob, RawLead } from "@/lib/domain/types";

// ---------------------------------------------------------------------------
// Source enablement is now a pure function of the settings it is handed, so
// these tests state the configuration directly.
//
// This replaced a harness that saved six environment variables, cleared them
// before every test, mutated process.env to change a flag, reset a memoised
// env cache, and restored everything afterwards -- all so a developer with
// ADZUNA_APP_ID exported in their shell got the same result as CI. None of that
// is needed to answer "is this source on?" any more.
// ---------------------------------------------------------------------------

const OFF = defaultSettings();
const on = (overrides: Partial<Settings>): Settings => ({ ...OFF, ...overrides });

// Adzuna is still gated on env, because its credentials are secret and stay
// there. These two tests own that variable and nothing else.
const ORIGINAL_ADZUNA = {
  ADZUNA_APP_ID: process.env.ADZUNA_APP_ID,
  ADZUNA_APP_KEY: process.env.ADZUNA_APP_KEY,
};

function setAdzuna(id?: string, key?: string) {
  if (id === undefined) delete process.env.ADZUNA_APP_ID;
  else process.env.ADZUNA_APP_ID = id;
  if (key === undefined) delete process.env.ADZUNA_APP_KEY;
  else process.env.ADZUNA_APP_KEY = key;
  resetEnvCache();
}

beforeEach(() => setAdzuna(undefined, undefined));
afterEach(() => setAdzuna(ORIGINAL_ADZUNA.ADZUNA_APP_ID, ORIGINAL_ADZUNA.ADZUNA_APP_KEY));

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
      "wellfound_alert",
      "indeed_alert",
      "ycombinator",
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
      "ycombinator",
    ];
    for (const name of unconditional) {
      expect(byName(JOB_SOURCES, name).enabled(OFF), name).toBe(true);
    }
    expect(byName(LEAD_SOURCES, "arbeitnow_contract").enabled(OFF)).toBe(true);
    expect(byName(LEAD_SOURCES, "wwr_contract").enabled(OFF)).toBe(true);
  });

  describe("adzuna", () => {
    const adzuna = () => byName(JOB_SOURCES, "adzuna");

    it("is disabled with a reason when neither key is set", () => {
      expect(adzuna().enabled(OFF)).toBe(false);
      const reason = adzuna().disabledReason?.();
      expect(reason).toBeTruthy();
      expect(reason).toContain("ADZUNA_APP_ID");
      expect(reason).toContain("ADZUNA_APP_KEY");
    });

    it("is disabled and names the missing half when only one key is set", () => {
      setAdzuna("app-id", undefined);
      expect(adzuna().enabled(OFF)).toBe(false);
      expect(adzuna().disabledReason?.()).toContain("ADZUNA_APP_KEY");
    });

    it("is enabled with no reason when both keys are set", () => {
      setAdzuna("app-id", "app-key");
      expect(adzuna().enabled(OFF)).toBe(true);
      expect(adzuna().disabledReason?.()).toBeUndefined();
    });
  });

  describe("upwork_rss (retired)", () => {
    const upwork = () => byName(LEAD_SOURCES, "upwork_rss");

    it("is retired, with a reason that names the 410 rather than a flag", () => {
      const reason = upwork().retired?.reason ?? "";
      expect(upwork().retired?.since).toBe("2026-08-21");
      expect(reason).toContain("410");
      // The point of the retirement: there is no configuration to go and fix,
      // so the message must not send the operator looking for one.
      expect(reason).not.toContain("ENABLE_UPWORK_RSS");
    });

    it("carries no fetcher at all", () => {
      // Not a stub that returns [] and not one that throws — genuinely absent,
      // so there is no dead code path that could be called by accident.
      expect(upwork().fetch).toBeUndefined();
    });

    it("cannot be switched back on at all", () => {
      // There is no flag left to set: ENABLE_UPWORK_RSS is gone from env, and
      // retirement is checked before enablement regardless.
      expect(upwork().enabled(OFF)).toBe(false);
      expect(upwork().enabled(on({}))).toBe(false);
    });
  });

  describe("linkedin_alert", () => {
    const linkedin = () => byName(JOB_SOURCES, "linkedin_alert");

    it("is disabled by default, with a reason naming the flag", () => {
      expect(linkedin().enabled(OFF)).toBe(false);
      expect(linkedin().disabledReason?.()).toContain("Settings");
    });

    it("is enabled when the setting is on", () => {
      expect(linkedin().enabled(on({ ENABLE_LINKEDIN_ALERTS: true }))).toBe(true);
    });
  });

  describe("wellfound_alert", () => {
    const wellfound = () => byName(JOB_SOURCES, "wellfound_alert");

    it("is disabled by default, with a reason naming the flag", () => {
      expect(wellfound().enabled(OFF)).toBe(false);
      expect(wellfound().disabledReason?.()).toContain("Settings");
    });

    it("is enabled when the setting is on", () => {
      expect(wellfound().enabled(on({ ENABLE_WELLFOUND_ALERTS: true }))).toBe(true);
    });
  });

  describe("indeed_alert", () => {
    const indeed = () => byName(JOB_SOURCES, "indeed_alert");

    it("is disabled by default, with a reason naming the flag", () => {
      expect(indeed().enabled(OFF)).toBe(false);
      expect(indeed().disabledReason?.()).toContain("Settings");
    });

    it("is enabled when the setting is on", () => {
      expect(indeed().enabled(on({ ENABLE_INDEED_ALERTS: true }))).toBe(true);
    });
  });

  it("re-reads its source of truth on every call rather than capturing it at import time", () => {
    const adzuna = byName(JOB_SOURCES, "adzuna");
    expect(adzuna.enabled(OFF)).toBe(false);
    setAdzuna("a", "b");
    expect(adzuna.enabled(OFF)).toBe(true);
    setAdzuna(undefined, undefined);
    expect(adzuna.enabled(OFF)).toBe(false);
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
    const result = await fetchAllJobs(OFF, [
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
    const result = await fetchAllJobs(OFF, [
      fakeJobSource("good", async () => [job("1", "good")]),
      fakeJobSource("weird", async () => {
        throw "just a string";
      }),
    ]);

    expect(result.jobs).toHaveLength(1);
    expect(result.errors[0]).toContain("just a string");
  });

  it("survives a source that throws synchronously before returning a promise", async () => {
    const result = await fetchAllJobs(OFF, [
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
    const result = await fetchAllJobs(OFF, [
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
    const result = await fetchAllJobs(OFF, [
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
    const result = await fetchAllJobs(OFF, [
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
    const result = await fetchAllJobs(OFF, [
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
    const result = await fetchAllLeads(OFF, [
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

describe("retired sources", () => {
  const tombstone = (name: string): SourceDefinition<RawJob> => ({
    name,
    kind: "job",
    enabled: () => false,
    retired: { since: "2026-01-01", reason: "upstream returns 410 Gone" },
  });

  it("reports a retired source separately from disabled ones", async () => {
    const result = await fetchAllJobs(OFF, [
      fakeJobSource("on", async () => [job("1", "on")]),
      fakeJobSource("off", async () => [job("2", "off")], {
        enabled: () => false,
        disabledReason: () => "set SOME_FLAG=1",
      }),
      tombstone("dead"),
    ]);

    expect(result.jobs.map((j) => j.sourceId)).toEqual(["1"]);
    expect(result.skipped).toEqual(["off: set SOME_FLAG=1"]);
    expect(result.retired).toEqual(["dead: upstream returns 410 Gone"]);
    // The whole point: a retired upstream is not a problem to be fixed.
    expect(result.errors).toEqual([]);
  });

  it("never fetches a retired source, even if one is somehow supplied", async () => {
    let called = false;
    const result = await fetchAllJobs(OFF, [
      {
        ...tombstone("dead"),
        // A leftover fetcher must still never run — `retired` is checked before
        // anything else precisely so a half-finished retirement is still safe.
        fetch: async () => {
          called = true;
          return [job("1", "dead")];
        },
      },
    ]);

    expect(called).toBe(false);
    expect(result.jobs).toEqual([]);
  });

  it("stays retired even when enabled() returns true", async () => {
    // Otherwise setting a flag would promote a dead upstream back to an active
    // source that fails on every single run — the loop this design removes.
    const result = await fetchAllJobs(OFF, [
      { ...tombstone("dead"), enabled: () => true },
    ]);

    expect(result.retired).toEqual(["dead: upstream returns 410 Gone"]);
    expect(result.errors).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("reports an enabled source with no fetcher as an error, not silence", async () => {
    // Omitting fetch is only legal on a retired entry. A definition that is
    // active and fetcher-less is a registry bug and must be loud.
    const result = await fetchAllJobs(OFF, [
      { name: "broken_def", kind: "job", enabled: () => true },
    ]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("broken_def");
    expect(result.errors[0]).toContain("retired");
  });
});

describe("the real registries, run with everything disabled", () => {
  it("reports the flag-gated job sources as skipped without fetching", async () => {
    // Only the disabled sources are exercised here: the always-on ones are
    // filtered out before any fetch happens, so nothing hits the network.
    const jobs = await fetchAllJobs(
      OFF,
      JOB_SOURCES.filter((s) => !s.enabled(OFF))
    );
    expect(jobs.jobs).toEqual([]);
    expect(jobs.skipped.map((s) => s.split(":")[0]).sort()).toEqual([
      "adzuna",
      "indeed_alert",
      "linkedin_alert",
      "wellfound_alert",
    ]);
    expect(jobs.retired).toEqual([]);
  });

  it("reports upwork_rss as retired rather than skipped", async () => {
    const leads = await fetchAllLeads(
      OFF,
      LEAD_SOURCES.filter((s) => !s.enabled(OFF))
    );
    expect(leads.leads).toEqual([]);
    expect(leads.skipped).toEqual([]);
    expect(leads.retired.map((s) => s.split(":")[0])).toEqual(["upwork_rss"]);
  });
});
