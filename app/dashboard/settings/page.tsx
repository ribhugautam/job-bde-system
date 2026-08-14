import { LINKS } from "@/lib/domain/scoring/resume-profile";

export const dynamic = "force-dynamic";

/**
 * `fallback` is the value the app uses when the variable is unset, for the ones
 * that have a documented default. Without it a var like ENABLE_LINKEDIN_ENRICH
 * — which is ON unless you turn it off — renders as a red "missing", which
 * reads as broken when the feature is in fact running.
 *
 * Only the required variables show red. Everything else is amber ("default") or
 * grey ("not set"), so the red items are exactly the ones worth acting on.
 */
function EnvRow({
  name,
  hint,
  required,
  fallback,
}: {
  name: string;
  hint: string;
  required?: boolean;
  fallback?: string;
}) {
  const set = Boolean(process.env[name]);

  let label: string;
  let tone: string;
  if (set) {
    label = "set";
    tone = "text-(--ok-fg)";
  } else if (fallback !== undefined) {
    label = `default: ${fallback}`;
    tone = "text-(--warn-fg)";
  } else if (required) {
    label = "missing";
    tone = "text-(--danger-fg)";
  } else {
    label = "not set";
    tone = "text-(--text-dim)";
  }

  return (
    <div className="flex items-center justify-between gap-3 border-b border-(--border) py-2 text-sm">
      <div className="min-w-0">
        <div className="font-mono text-xs">{name}</div>
        <div className="text-xs text-(--text-dim)">{hint}</div>
      </div>
      <span className={`shrink-0 text-xs ${tone}`}>{label}</span>
    </div>
  );
}

export default function SettingsPage() {
  const dryRun = process.env.DRY_RUN === "1";
  return (
    <div className="space-y-8 max-w-2xl">
      <div
        className={`rounded border p-3 ${
          dryRun
            ? "border-(--warn-fg) bg-(--warn-bg)"
            : "border-(--danger-fg) bg-(--danger-bg)"
        }`}
      >
        <div
          className={`text-sm font-semibold ${dryRun ? "text-(--warn-fg)" : "text-(--danger-fg)"}`}
        >
          {dryRun ? "DRY RUN — no email will be sent" : "LIVE — email will be sent automatically"}
        </div>
        <div className="mt-1 text-xs text-(--text-muted)">
          {dryRun
            ? "The daily run drafts applications and pitches into the dashboard only. Nothing leaves your Gmail, including the digest. Set DRY_RUN=0 (or remove it) to go live."
            : "Applications auto-send to any listing that publishes an apply-by-email address, and outreach auto-sends up to the daily cap. Set DRY_RUN=1 to draft without sending."}
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-(--text-muted)">Environment</h2>
        <div className="rounded border border-(--border) p-3">
          <EnvRow required name="APP_PASSWORD" hint="Unlocks the whole app; min 8 chars (use random, not a word) or every route serves 503" />
          <EnvRow required name="AUTH_SECRET" hint="Signs the session cookie; openssl rand -hex 32" />
          <EnvRow required name="CRON_SECRET" hint="Protects /api/cron/daily - the one route outside the password gate" />
          <details className="border-b border-(--border) py-2 text-xs text-(--text-dim)">
            <summary className="cursor-pointer">
              Trigger from a terminal or CI instead
            </summary>
            <p className="mt-2">
              The Run pipeline button in the header is authorized by your
              dashboard session, so no secret is involved there. Outside the
              browser there is no session, so use{" "}
              <span className="font-mono">CRON_SECRET</span> against the cron
              route. It goes in the{" "}
              <span className="font-mono">Authorization</span> header — it is
              deliberately not accepted as a query param, because query
              strings are written to Vercel&apos;s request logs in plaintext.
            </p>
            <pre className="mt-2 overflow-x-auto rounded bg-(--surface) p-3 text-(--text-muted)">
              curl -X GET -H &quot;Authorization: Bearer $CRON_SECRET&quot; \{"\n"}
              {"  "}
              {process.env.NEXT_PUBLIC_APP_URL || "https://your-app.vercel.app"}
              /api/cron/daily
            </pre>
          </details>
          <EnvRow name="TURSO_DATABASE_URL" hint="libSQL/Turso database URL" fallback="local ./local.db file" />
          <EnvRow name="TURSO_AUTH_TOKEN" hint="Turso token; required whenever the URL is remote" />
          <EnvRow required name="GMAIL_USER" hint="Gmail address that sends applications, outreach and follow-ups" />
          <EnvRow required name="GMAIL_APP_PASSWORD" hint="16-char app password, not your normal Gmail password" />
          <EnvRow name="OWNER_EMAIL" hint="Where the digest gets sent" fallback="GMAIL_USER" />
          <EnvRow name="DRY_RUN" hint="Draft everything, send nothing - see the banner above" fallback="0 (live)" />
          <EnvRow name="MATCH_THRESHOLD" hint="Fit score a job must reach to be drafted" fallback="40" />
          <EnvRow name="ENABLE_LINKEDIN_ALERTS" hint="Reads LinkedIn job alerts from your own inbox over IMAP, read-only" fallback="off" />
          <EnvRow name="ENABLE_WELLFOUND_ALERTS" hint="Reads Wellfound &quot;New jobs:&quot; digests from your own inbox over IMAP, read-only" fallback="off" />
          <EnvRow name="ENABLE_INDEED_ALERTS" hint="Reads Indeed job-alert digests the same way; high volume, skews toward agency postings" fallback="off" />
          <EnvRow name="ENABLE_LINKEDIN_ENRICH" hint="Recovers descriptions from the public LinkedIn page (no login, no session)" fallback="on" />
          <EnvRow name="LINKEDIN_ENRICH_DAILY_CAP" hint="Max public page fetches per day" fallback="80" />
          <EnvRow name="ENABLE_FOLLOWUPS" hint="One nudge at day 4, a final at day 10, then stop permanently" fallback="on" />
          <EnvRow name="FOLLOWUP_DAILY_CAP" hint="Max follow-up emails per day" fallback="20" />
          <EnvRow name="WORKER_TIME_BUDGET_MS" hint="Worker stops cleanly here and resumes next run" fallback="45000" />
          <EnvRow name="ANTHROPIC_API_KEY" hint="AI-written drafts instead of the built-in templates" />
          <EnvRow name="ADZUNA_APP_ID" hint="Adzuna source is skipped unless BOTH key vars are set" />
          <EnvRow name="ADZUNA_APP_KEY" hint="See above" />
          <EnvRow name="OUTREACH_DAILY_CAP" hint="Max cold pitches auto-sent per day" fallback="10" />
          <EnvRow name="ENABLE_UPWORK_RSS" hint="Experimental - enable only after verifying the feed URL" fallback="off" />
          <EnvRow name="NEXT_PUBLIC_APP_URL" hint="Your deployed URL, used in the digest email's links" />
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-(--text-muted)">Links used in drafts — verify these</h2>
        <div className="rounded border border-(--border) p-3 text-sm space-y-1">
          <div>LinkedIn: {LINKS.linkedin} <span className="text-(--ok-fg) text-xs">(confirmed)</span></div>
          <div className="text-(--text-dim)">
            GitHub: {LINKS.github}{" "}
            <span className="text-(--warn-fg) text-xs">
              (excluded from all outreach — pinned repos are student projects. Repin, then re-add it in lib/domain/drafting/compose.ts)
            </span>
          </div>
          <div>Portfolio: {LINKS.portfolio}</div>
          <div>Ziro: {LINKS.ziro}</div>
          <div>Email: {LINKS.email}</div>
        </div>
        <p className="mt-2 text-xs text-(--text-dim)">
          Edit lib/domain/scoring/resume-profile.ts to fix any of these — they flow straight into every cover letter and pitch.
        </p>
      </div>
    </div>
  );
}
