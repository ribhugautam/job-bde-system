import { z } from "zod";

// ---------------------------------------------------------------------------
// Operational settings: everything an admin can change from the dashboard
// without a redeploy.
//
// These used to be environment variables. That made every tuning decision a
// Vercel edit plus a deploy, which is slow enough that nobody tunes anything —
// and it buried the ~15 values in .env that genuinely are secret among 20 that
// are not.
//
// THE LINE between this file and lib/config/env.ts:
//
//   env.ts    — secrets, infrastructure, and anything that must be readable
//               BEFORE a database connection exists. Synchronous.
//   this file — values a person may legitimately change at runtime. Read from
//               the database, so necessarily asynchronous.
//
// A value belongs here only if leaking it would be harmless. Nothing in this
// file is a credential.
//
// This module is PURE: schema, defaults and bounds, no database. The storage
// lives in lib/infra/db/settings.ts, which imports this to validate what it
// reads. That split is what lets every parsing rule below be tested without a
// database.
// ---------------------------------------------------------------------------

/**
 * The worker's wall-clock budget ceiling.
 *
 * The route this runs under declares `maxDuration = 60` (seconds), and the
 * worker reserves 17s internally for tail stages (TAIL_RESERVE_MS +
 * BATCH_RESERVE_MS in lib/pipeline/deadline.ts). 50s leaves the reserves plus
 * room for the digest to write and send.
 *
 * The old env schema allowed up to 800,000ms — thirteen minutes on a
 * sixty-second function. That was survivable while changing it meant a
 * deliberate env edit and a deploy; as a number field on a settings page it is
 * one click away from a worker killed mid-write.
 */
export const MAX_WORKER_BUDGET_MS = 50_000;

export const settingsSchema = z.object({
  // --- Safety ------------------------------------------------------------
  /**
   * Drafts everything, sends nothing.
   *
   * NOT the whole story: the effective value is `envDryRun || settingsDryRun`
   * (see effectiveDryRun below). Env can force this ON and never off, so a
   * deploy-level stop cannot be undone from the dashboard.
   */
  DRY_RUN: z.boolean().default(false),

  // --- Matching ----------------------------------------------------------
  MATCH_THRESHOLD: z.number().int().min(0).max(100).default(40),
  /** How long an untriaged job stays in the inbox before it archives. */
  JOB_STALE_DAYS: z.number().int().min(1).max(365).default(30),

  // --- Sources -----------------------------------------------------------
  ENABLE_LINKEDIN_ALERTS: z.boolean().default(false),
  ENABLE_WELLFOUND_ALERTS: z.boolean().default(false),
  ENABLE_INDEED_ALERTS: z.boolean().default(false),
  LINKEDIN_ALERT_DAYS: z.number().int().min(1).max(30).default(3),

  // --- LinkedIn enrichment ----------------------------------------------
  ENABLE_LINKEDIN_ENRICH: z.boolean().default(true),
  LINKEDIN_ENRICH_DAILY_CAP: z.number().int().min(0).max(500).default(80),
  LINKEDIN_ENRICH_DELAY_MS: z.number().int().min(0).max(60_000).default(1500),

  // --- Follow-ups --------------------------------------------------------
  ENABLE_FOLLOWUPS: z.boolean().default(true),
  FOLLOWUP_FIRST_DAYS: z.number().int().min(1).max(60).default(4),
  FOLLOWUP_FINAL_DAYS: z.number().int().min(2).max(120).default(10),
  FOLLOWUP_DAILY_CAP: z.number().int().min(0).max(200).default(20),

  // --- Worker ------------------------------------------------------------
  WORKER_TIME_BUDGET_MS: z
    .number()
    .int()
    .min(1_000)
    .max(MAX_WORKER_BUDGET_MS)
    .default(45_000),
  WORKER_BATCH_SIZE: z.number().int().min(1).max(500).default(25),

  // --- Outreach ----------------------------------------------------------
  OUTREACH_DAILY_CAP: z.number().int().min(0).max(200).default(10),

  // --- IMAP (non-secret half; credentials stay in env) -------------------
  IMAP_HOST: z.string().min(1).default("imap.gmail.com"),
  IMAP_PORT: z.number().int().min(1).max(65535).default(993),
  IMAP_MAILBOX: z.string().min(1).default("INBOX"),
});

export type Settings = z.infer<typeof settingsSchema>;

/** Every key this module owns — used to detect now-inert env vars. */
export const SETTING_KEYS = Object.keys(settingsSchema.shape) as (keyof Settings)[];

export function defaultSettings(): Settings {
  return settingsSchema.parse({});
}

/**
 * Cross-field rules, kept separate from the per-field schema.
 *
 * Returns messages rather than throwing, because these are shown next to a form
 * field. As env vars these were a startup crash, which is the right behaviour
 * for a deployment that cannot run — and the wrong behaviour for somebody who
 * has just typed a number into a box.
 */
export function validateSettings(settings: Settings): string[] {
  const problems: string[] = [];

  if (settings.FOLLOWUP_FINAL_DAYS <= settings.FOLLOWUP_FIRST_DAYS) {
    problems.push(
      `The final follow-up (day ${settings.FOLLOWUP_FINAL_DAYS}) must come after ` +
        `the first (day ${settings.FOLLOWUP_FIRST_DAYS}), or both would fire at once.`
    );
  }

  return problems;
}

/**
 * Parses stored/submitted settings. TOTAL — never throws.
 *
 * Every value here can arrive from a JSON column or a request body, so a bad
 * one falls back to its default rather than taking down the page that reads it.
 * A settings row corrupted by hand must degrade to sane behaviour, not to a
 * dashboard nobody can open to fix it.
 *
 * Note this deliberately does NOT enforce the cross-field rules above: a stored
 * row that somehow violates them still has to load, or the settings page could
 * not render to correct it. validateSettings() gates writes; this gates reads.
 */
export function parseSettings(raw: unknown): Settings {
  const base = defaultSettings();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;

  const input = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  // Field by field rather than one schema.safeParse of the whole object: a
  // single bad value would otherwise discard every good value alongside it.
  for (const key of SETTING_KEYS) {
    const field = settingsSchema.shape[key];
    const result = field.safeParse(input[key]);
    out[key] = result.success ? result.data : base[key];
  }

  return out as Settings;
}

/**
 * The effective kill switch.
 *
 * OR, never override. Env can force dry-run ON; it can never turn it off. That
 * asymmetry is the whole point: the settings toggle gives day-to-day control,
 * while `DRY_RUN=1` in the environment is a stop that no dashboard session can
 * undo — including one belonging to an admin who has been compromised, or who
 * clicked the wrong thing.
 */
export function effectiveDryRun(opts: {
  envDryRun: boolean;
  settingsDryRun: boolean;
}): boolean {
  return opts.envDryRun || opts.settingsDryRun;
}
