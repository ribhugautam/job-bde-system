import { describe, expect, it } from "vitest";
import {
  MAX_WORKER_BUDGET_MS,
  SETTING_KEYS,
  defaultSettings,
  effectiveDryRun,
  parseSettings,
  validateSettings,
} from "@/lib/config/settings";

describe("defaults", () => {
  it("keeps the values these settings had as environment variables", () => {
    // The migration seeds this row from env, so an unset key must land on
    // exactly what it used to default to. A drift here silently changes what a
    // live deployment does the moment it deploys.
    const s = defaultSettings();
    expect(s.MATCH_THRESHOLD).toBe(40);
    expect(s.JOB_STALE_DAYS).toBe(30);
    expect(s.FOLLOWUP_FIRST_DAYS).toBe(4);
    expect(s.FOLLOWUP_FINAL_DAYS).toBe(10);
    expect(s.FOLLOWUP_DAILY_CAP).toBe(20);
    expect(s.OUTREACH_DAILY_CAP).toBe(10);
    expect(s.WORKER_BATCH_SIZE).toBe(25);
    expect(s.WORKER_TIME_BUDGET_MS).toBe(45_000);
    expect(s.LINKEDIN_ENRICH_DAILY_CAP).toBe(80);
    expect(s.LINKEDIN_ENRICH_DELAY_MS).toBe(1500);
    expect(s.IMAP_HOST).toBe("imap.gmail.com");
    expect(s.IMAP_PORT).toBe(993);
    expect(s.IMAP_MAILBOX).toBe("INBOX");
  });

  it("defaults the alert sources off and enrichment on", () => {
    const s = defaultSettings();
    expect(s.ENABLE_LINKEDIN_ALERTS).toBe(false);
    expect(s.ENABLE_WELLFOUND_ALERTS).toBe(false);
    expect(s.ENABLE_INDEED_ALERTS).toBe(false);
    expect(s.ENABLE_LINKEDIN_ENRICH).toBe(true);
    expect(s.ENABLE_FOLLOWUPS).toBe(true);
  });

  it("defaults DRY_RUN off, matching the previous env default", () => {
    expect(defaultSettings().DRY_RUN).toBe(false);
  });
});

describe("parseSettings", () => {
  it("is total: garbage in, defaults out, never a throw", () => {
    // This row is read on every page load and every pipeline run. A corrupted
    // value must not break the settings page an admin would use to fix it.
    const base = defaultSettings();
    for (const raw of [null, undefined, "a string", 42, [], { nope: true }]) {
      expect(parseSettings(raw), String(raw)).toEqual(base);
    }
  });

  it("keeps good values when a neighbouring one is bad", () => {
    // Field by field, not one whole-object parse -- otherwise a single bad
    // value would silently discard every good value stored alongside it.
    const parsed = parseSettings({
      MATCH_THRESHOLD: 65,
      JOB_STALE_DAYS: "not a number",
      WORKER_BATCH_SIZE: 50,
    });
    expect(parsed.MATCH_THRESHOLD).toBe(65);
    expect(parsed.WORKER_BATCH_SIZE).toBe(50);
    expect(parsed.JOB_STALE_DAYS).toBe(defaultSettings().JOB_STALE_DAYS);
  });

  it("falls back to the default for an out-of-range value", () => {
    expect(parseSettings({ MATCH_THRESHOLD: 500 }).MATCH_THRESHOLD).toBe(40);
    expect(parseSettings({ MATCH_THRESHOLD: -5 }).MATCH_THRESHOLD).toBe(40);
    expect(parseSettings({ JOB_STALE_DAYS: 0 }).JOB_STALE_DAYS).toBe(30);
  });

  it("rejects a worker budget beyond the function's real ceiling", () => {
    // maxDuration is 60s and the worker reserves 17s internally. The old env
    // schema allowed 800,000ms -- thirteen minutes on a sixty-second function.
    // Survivable when changing it meant an env edit and a deploy; one click
    // from a worker killed mid-write on a settings form.
    expect(parseSettings({ WORKER_TIME_BUDGET_MS: 800_000 }).WORKER_TIME_BUDGET_MS).toBe(
      45_000
    );
    expect(parseSettings({ WORKER_TIME_BUDGET_MS: MAX_WORKER_BUDGET_MS })
      .WORKER_TIME_BUDGET_MS).toBe(MAX_WORKER_BUDGET_MS);
    expect(MAX_WORKER_BUDGET_MS).toBeLessThan(60_000);
  });

  it("rejects a non-boolean where a boolean belongs", () => {
    // "false" as a STRING is the classic one -- truthy in JavaScript, and it
    // would read as "sending is on".
    expect(parseSettings({ DRY_RUN: "false" }).DRY_RUN).toBe(false);
    expect(parseSettings({ DRY_RUN: 1 }).DRY_RUN).toBe(false);
    expect(parseSettings({ DRY_RUN: true }).DRY_RUN).toBe(true);
  });

  it("returns every key, so a stored row is always complete", () => {
    const parsed = parseSettings({ MATCH_THRESHOLD: 50 });
    for (const key of SETTING_KEYS) {
      expect(parsed[key], key).toBeDefined();
    }
  });

  it("does not enforce cross-field rules on read", () => {
    // A row that somehow violates them still has to LOAD, or the settings page
    // could not render to correct it. validateSettings() gates writes instead.
    const parsed = parseSettings({ FOLLOWUP_FIRST_DAYS: 10, FOLLOWUP_FINAL_DAYS: 3 });
    expect(parsed.FOLLOWUP_FIRST_DAYS).toBe(10);
    expect(parsed.FOLLOWUP_FINAL_DAYS).toBe(3);
  });
});

describe("validateSettings", () => {
  it("accepts the defaults", () => {
    expect(validateSettings(defaultSettings())).toEqual([]);
  });

  it("rejects a final follow-up scheduled before the first", () => {
    // Otherwise both fire in the same run and one person gets two emails at once.
    const problems = validateSettings({
      ...defaultSettings(),
      FOLLOWUP_FIRST_DAYS: 10,
      FOLLOWUP_FINAL_DAYS: 4,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/final follow-up/i);
  });

  it("rejects equal follow-up offsets", () => {
    expect(
      validateSettings({
        ...defaultSettings(),
        FOLLOWUP_FIRST_DAYS: 5,
        FOLLOWUP_FINAL_DAYS: 5,
      })
    ).toHaveLength(1);
  });
});

describe("effectiveDryRun", () => {
  // The asymmetry IS the safety property: env may force dry-run on, and can
  // never turn it off. A settings toggle gives day-to-day control; DRY_RUN=1 in
  // the environment is a stop no dashboard session can undo -- including one
  // belonging to a compromised admin.
  it("is on when the environment says so, whatever the setting says", () => {
    expect(effectiveDryRun({ envDryRun: true, settingsDryRun: false })).toBe(true);
    expect(effectiveDryRun({ envDryRun: true, settingsDryRun: true })).toBe(true);
  });

  it("is on when the setting says so and the environment is silent", () => {
    expect(effectiveDryRun({ envDryRun: false, settingsDryRun: true })).toBe(true);
  });

  it("is off only when BOTH are off", () => {
    expect(effectiveDryRun({ envDryRun: false, settingsDryRun: false })).toBe(false);
  });
});
