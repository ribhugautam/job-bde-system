import { z } from "zod";
import { MIN_PASSWORD_LENGTH, MIN_SECRET_LENGTH } from "./auth-policy";

// ---------------------------------------------------------------------------
// The single place process.env is read — and, now, SECRETS ONLY.
//
// This file used to hold 35 variables. Twenty of them were operational tuning
// (match threshold, source toggles, follow-up cadence, worker limits), and
// changing any one meant editing Vercel and redeploying. That was slow enough
// that nothing ever got tuned, and their bulk buried the values that genuinely
// are secret. Those twenty now live in the database — see
// lib/config/settings.ts and lib/infra/db/settings.ts.
//
// THE TEST FOR WHETHER SOMETHING BELONGS HERE:
//
//   1. Would leaking it be harmful?                          -> here
//   2. Is it needed BEFORE a database connection exists?     -> here
//      (auth gate, the database URL itself, the cron secret)
//   3. Is it inlined at build time by Next?                  -> here
//      (NEXT_PUBLIC_APP_URL — it physically cannot come from a row)
//
// Anything else is a setting, and putting it here is a regression.
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

const optionalStr = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const schema = z.object({
  // --- Database ------------------------------------------------------------
  // Unset -> local ./local.db SQLite file. The remote-URL-without-token case is
  // caught below rather than here, so the error names both keys at once.
  TURSO_DATABASE_URL: optionalStr,
  TURSO_AUTH_TOKEN: optionalStr,

  // --- Outbound mail -------------------------------------------------------
  // Legacy/fallback sender. Each user now stores their own mailbox (encrypted,
  // in user_mail); these remain for the unattended pipeline and for a
  // deployment that has not set anybody up yet.
  GMAIL_USER: optionalStr,
  GMAIL_APP_PASSWORD: optionalStr,
  // Also read directly by the first-admin seed, before any account exists.
  OWNER_EMAIL: optionalStr,

  // --- Dashboard auth ------------------------------------------------------
  // Lengths come from lib/config/auth-policy.ts, which lib/infra/auth.ts also
  // reads. They were previously hardcoded separately in both places, so raising
  // one would have left the other accepting a shorter value — the app would
  // validate at startup and then 503 at the gate.
  APP_PASSWORD: z
    .string()
    .min(
      MIN_PASSWORD_LENGTH,
      `APP_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`
    )
    .optional(),
  AUTH_SECRET: z
    .string()
    .min(
      MIN_SECRET_LENGTH,
      `AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters`
    )
    .optional(),

  /**
   * Encrypts colleagues' stored mailbox passwords at rest.
   *
   * SEPARATE FROM AUTH_SECRET on purpose. AUTH_SECRET signs session cookies and
   * is expected to be rotated — the docs already say rotating it signs everyone
   * out, which is cheap and recoverable. If it also encrypted credentials, that
   * same rotation would silently destroy every stored mailbox password, and the
   * damage would surface days later as applications quietly failing to send.
   *
   * Optional: without it, mailbox setup is refused outright and everything is
   * drafted and queued instead. Nothing falls back to storing a plaintext
   * secret.
   */
  ENCRYPTION_KEY: z
    .string()
    .min(32, "ENCRYPTION_KEY must be at least 32 characters (openssl rand -hex 32)")
    .optional(),

  // --- Cron ----------------------------------------------------------------
  CRON_SECRET: optionalStr,

  // --- Safety --------------------------------------------------------------
  /**
   * The deploy-level kill switch.
   *
   * DRY_RUN is now a settings toggle, but this env var remains and it can only
   * ever force dry-run ON — see effectiveDryRun() in lib/config/settings.ts.
   * That asymmetry is the point: the toggle gives day-to-day control, while
   * setting this to 1 is a stop that no dashboard session can undo, including
   * one belonging to an admin who has been compromised or clicked the wrong
   * thing.
   */
  DRY_RUN: z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === ""
        ? false
        : ["1", "true", "yes", "on"].includes(v.trim().toLowerCase())
    ),

  // --- IMAP credentials ----------------------------------------------------
  // Host, port and mailbox are settings; only the credentials live here.
  IMAP_USER: optionalStr,
  IMAP_PASSWORD: optionalStr,

  // --- Optional sources / providers ----------------------------------------
  ADZUNA_APP_ID: optionalStr,
  ADZUNA_APP_KEY: optionalStr,
  ANTHROPIC_API_KEY: optionalStr,

  // Inlined at build time by Next, so it cannot be a runtime setting.
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
    ENCRYPTION_KEY: raw.ENCRYPTION_KEY,
    CRON_SECRET: raw.CRON_SECRET,
    DRY_RUN: raw.DRY_RUN,
    IMAP_USER: raw.IMAP_USER,
    IMAP_PASSWORD: raw.IMAP_PASSWORD,
    ADZUNA_APP_ID: raw.ADZUNA_APP_ID,
    ADZUNA_APP_KEY: raw.ADZUNA_APP_KEY,
    ANTHROPIC_API_KEY: raw.ANTHROPIC_API_KEY,
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
