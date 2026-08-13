import { z } from "zod";

// ---------------------------------------------------------------------------
// The single place process.env is read.
//
// Two accessors, deliberately:
//
//   getEnv()     throws an aggregated error listing every invalid key. Use this
//                from pipeline/worker/server code, where a misconfigured
//                deployment should fail loudly and immediately.
//
//   getEnvSafe() returns a result and never throws. proxy.ts needs this: when
//                APP_PASSWORD/AUTH_SECRET are missing the app must serve a 503
//                "auth not configured" page, not crash with a 500. A throwing
//                accessor in the proxy would turn a fail-closed design into an
//                opaque runtime error on every single request.
//
// Every key is referenced explicitly rather than looked up dynamically, because
// Next.js statically inlines `process.env.FOO` at build time and a dynamic
// `process.env[name]` lookup is not substituted in bundled contexts.
// ---------------------------------------------------------------------------

/** "1"/"true"/"yes" -> true. Anything else (including unset) -> false. */
const boolFlag = (fallback = false) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === ""
        ? fallback
        : ["1", "true", "yes", "on"].includes(v.trim().toLowerCase())
    );

const intWithDefault = (fallback: number, min?: number, max?: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? fallback : Number(v)))
    .pipe(
      z
        .number()
        .int()
        .min(min ?? Number.MIN_SAFE_INTEGER)
        .max(max ?? Number.MAX_SAFE_INTEGER)
    );

const optionalStr = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const schema = z.object({
  // --- Database ------------------------------------------------------------
  // Unset -> local ./local.db SQLite file. The remote-URL-without-token case is
  // caught by the superRefine below rather than here, so the error names both
  // keys at once.
  TURSO_DATABASE_URL: optionalStr,
  TURSO_AUTH_TOKEN: optionalStr,

  // --- Outbound mail -------------------------------------------------------
  GMAIL_USER: optionalStr,
  GMAIL_APP_PASSWORD: optionalStr,
  OWNER_EMAIL: optionalStr,

  // --- Dashboard auth ------------------------------------------------------
  // 12 chars is enforced here so the rule lives in one place; proxy.ts reads
  // the result rather than re-checking the length itself.
  APP_PASSWORD: z
    .string()
    .min(12, "APP_PASSWORD must be at least 12 characters")
    .optional(),
  AUTH_SECRET: z
    .string()
    .min(16, "AUTH_SECRET must be at least 16 characters")
    .optional(),

  // --- Cron ----------------------------------------------------------------
  CRON_SECRET: optionalStr,

  // --- Safety --------------------------------------------------------------
  // The master kill switch: drafts everything, sends nothing, not even digests.
  DRY_RUN: boolFlag(false),

  // --- Matching ------------------------------------------------------------
  MATCH_THRESHOLD: intWithDefault(40, 0, 100),

  // --- LinkedIn ingest (own inbox, IMAP, read-only) ------------------------
  ENABLE_LINKEDIN_ALERTS: boolFlag(false),
  IMAP_HOST: z.string().optional().default("imap.gmail.com"),
  IMAP_PORT: intWithDefault(993, 1, 65535),
  IMAP_MAILBOX: z.string().optional().default("INBOX"),
  IMAP_USER: optionalStr,
  IMAP_PASSWORD: optionalStr,
  LINKEDIN_ALERT_DAYS: intWithDefault(3, 1, 30),

  // --- LinkedIn enrichment (unauthenticated public job page) ---------------
  // No login, no cookie, no session. Capped and spaced so a run cannot turn
  // into a burst; on 429/403 the job simply stays sparse.
  ENABLE_LINKEDIN_ENRICH: boolFlag(true),
  LINKEDIN_ENRICH_DAILY_CAP: intWithDefault(80, 0, 500),
  LINKEDIN_ENRICH_DELAY_MS: intWithDefault(1500, 0, 60_000),

  // --- Follow-ups ----------------------------------------------------------
  ENABLE_FOLLOWUPS: boolFlag(true),
  FOLLOWUP_FIRST_DAYS: intWithDefault(4, 1, 60),
  FOLLOWUP_FINAL_DAYS: intWithDefault(10, 2, 120),
  FOLLOWUP_DAILY_CAP: intWithDefault(20, 0, 200),

  // --- Worker --------------------------------------------------------------
  // Budget must stay under the route's maxDuration with room for the digest.
  WORKER_TIME_BUDGET_MS: intWithDefault(45_000, 1_000, 800_000),
  WORKER_BATCH_SIZE: intWithDefault(25, 1, 500),

  // --- Optional sources / providers ---------------------------------------
  ADZUNA_APP_ID: optionalStr,
  ADZUNA_APP_KEY: optionalStr,
  ANTHROPIC_API_KEY: optionalStr,
  ENABLE_UPWORK_RSS: boolFlag(false),
  OUTREACH_DAILY_CAP: intWithDefault(10, 0, 200),

  NEXT_PUBLIC_APP_URL: optionalStr,
});

export type Env = z.infer<typeof schema> & {
  /** Resolved: the explicit Turso URL, or the local SQLite fallback. */
  databaseUrl: string;
  /** True when auth is fully configured; proxy.ts serves 503 when false. */
  authConfigured: boolean;
};

function build(raw: NodeJS.ProcessEnv) {
  // Listed explicitly — see the note on static inlining at the top of the file.
  const parsed = schema.safeParse({
    TURSO_DATABASE_URL: raw.TURSO_DATABASE_URL,
    TURSO_AUTH_TOKEN: raw.TURSO_AUTH_TOKEN,
    GMAIL_USER: raw.GMAIL_USER,
    GMAIL_APP_PASSWORD: raw.GMAIL_APP_PASSWORD,
    OWNER_EMAIL: raw.OWNER_EMAIL,
    APP_PASSWORD: raw.APP_PASSWORD,
    AUTH_SECRET: raw.AUTH_SECRET,
    CRON_SECRET: raw.CRON_SECRET,
    DRY_RUN: raw.DRY_RUN,
    MATCH_THRESHOLD: raw.MATCH_THRESHOLD,
    ENABLE_LINKEDIN_ALERTS: raw.ENABLE_LINKEDIN_ALERTS,
    IMAP_HOST: raw.IMAP_HOST,
    IMAP_PORT: raw.IMAP_PORT,
    IMAP_MAILBOX: raw.IMAP_MAILBOX,
    IMAP_USER: raw.IMAP_USER,
    IMAP_PASSWORD: raw.IMAP_PASSWORD,
    LINKEDIN_ALERT_DAYS: raw.LINKEDIN_ALERT_DAYS,
    ENABLE_LINKEDIN_ENRICH: raw.ENABLE_LINKEDIN_ENRICH,
    LINKEDIN_ENRICH_DAILY_CAP: raw.LINKEDIN_ENRICH_DAILY_CAP,
    LINKEDIN_ENRICH_DELAY_MS: raw.LINKEDIN_ENRICH_DELAY_MS,
    ENABLE_FOLLOWUPS: raw.ENABLE_FOLLOWUPS,
    FOLLOWUP_FIRST_DAYS: raw.FOLLOWUP_FIRST_DAYS,
    FOLLOWUP_FINAL_DAYS: raw.FOLLOWUP_FINAL_DAYS,
    FOLLOWUP_DAILY_CAP: raw.FOLLOWUP_DAILY_CAP,
    WORKER_TIME_BUDGET_MS: raw.WORKER_TIME_BUDGET_MS,
    WORKER_BATCH_SIZE: raw.WORKER_BATCH_SIZE,
    ADZUNA_APP_ID: raw.ADZUNA_APP_ID,
    ADZUNA_APP_KEY: raw.ADZUNA_APP_KEY,
    ANTHROPIC_API_KEY: raw.ANTHROPIC_API_KEY,
    ENABLE_UPWORK_RSS: raw.ENABLE_UPWORK_RSS,
    OUTREACH_DAILY_CAP: raw.OUTREACH_DAILY_CAP,
    NEXT_PUBLIC_APP_URL: raw.NEXT_PUBLIC_APP_URL,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${i.path.join(".") || "(root)"}: ${i.message}`
    );
    return { ok: false as const, issues };
  }

  const v = parsed.data;
  const databaseUrl = v.TURSO_DATABASE_URL ?? "file:./local.db";
  const issues: string[] = [];

  // A remote URL with no token fails at query time with an opaque libSQL error,
  // so surface it here where the message can name the fix.
  if (!databaseUrl.startsWith("file:") && !v.TURSO_AUTH_TOKEN) {
    issues.push(
      "TURSO_AUTH_TOKEN: required when TURSO_DATABASE_URL points at a remote " +
        "database. Run `turso db tokens create <db-name>`."
    );
  }

  // A final follow-up scheduled before the first would fire both at once.
  if (v.FOLLOWUP_FINAL_DAYS <= v.FOLLOWUP_FIRST_DAYS) {
    issues.push(
      `FOLLOWUP_FINAL_DAYS (${v.FOLLOWUP_FINAL_DAYS}) must be greater than ` +
        `FOLLOWUP_FIRST_DAYS (${v.FOLLOWUP_FIRST_DAYS}).`
    );
  }

  if (issues.length) return { ok: false as const, issues };

  return {
    ok: true as const,
    env: {
      ...v,
      databaseUrl,
      authConfigured: Boolean(v.APP_PASSWORD && v.AUTH_SECRET),
    } satisfies Env,
  };
}

type BuildResult = ReturnType<typeof build>;

let cached: BuildResult | null = null;

/** Never throws. Returns `{ ok: false, issues }` on a bad configuration. */
export function getEnvSafe(): BuildResult {
  if (!cached) cached = build(process.env);
  return cached;
}

/** Throws an aggregated, actionable error when the configuration is invalid. */
export function getEnv(): Env {
  const result = getEnvSafe();
  if (!result.ok) {
    throw new Error(
      `Invalid environment configuration:\n  - ${result.issues.join("\n  - ")}`
    );
  }
  return result.env;
}

/** Test-only: drop the memoised value after mutating process.env. */
export function resetEnvCache(): void {
  cached = null;
}
