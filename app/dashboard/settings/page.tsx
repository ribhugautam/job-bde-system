import { LINKS } from "@/lib/domain/scoring/resume-profile";
import { requireUser } from "@/lib/infra/session";
import { getMailSettings } from "@/lib/infra/db/user-mail";
import { getSettings, inertEnvVars } from "@/lib/infra/db/settings";
import { getEnv } from "@/lib/config/env";
import { canManageUsers } from "@/lib/domain/users/roles";
import MailSettings from "@/components/settings/MailSettings";
import RuntimeSettings from "@/components/settings/RuntimeSettings";
import DbErrorNotice from "@/components/DbErrorNotice";

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

export default async function SettingsPage() {
  const user = await requireUser("/dashboard/settings");

  let data;
  try {
    const [mail, settings] = await Promise.all([
      getMailSettings(user.id),
      getSettings(),
    ]);
    data = { mail, settings };
  } catch (err) {
    return <DbErrorNotice error={err} />;
  }

  const { mail, settings } = data;
  const isAdmin = canManageUsers(user.role);
  const envForcesDryRun = getEnv().DRY_RUN;
  // The EFFECTIVE value, combining both sources -- the raw setting alone would
  // report "live" on a deployment that env has stopped.
  const dryRun = envForcesDryRun || settings.DRY_RUN;
  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <h2 className="mb-2 text-sm font-semibold text-(--text-muted)">
          Your sending mailbox
        </h2>
        <MailSettings settings={mail} />
      </div>

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
            ? "The daily run drafts applications and pitches into the dashboard only. Nothing leaves the building, including the digest."
            : "Applications auto-send to any listing that publishes an apply-by-email address, and outreach auto-sends up to the daily cap."}
          {envForcesDryRun &&
            " Forced on by DRY_RUN in the environment, which cannot be lifted from the dashboard."}
        </div>
      </div>

      {/*
        Admin only, and gated server-side rather than merely hidden: these
        decide what the shared pipeline does for everyone, not a personal
        preference. The API route enforces the same rule.
      */}
      {isAdmin && (
        <div>
          <h2 className="mb-2 text-sm font-semibold text-(--text-muted)">
            Pipeline settings
          </h2>
          <RuntimeSettings
            settings={settings}
            inertEnv={inertEnvVars()}
            envForcesDryRun={envForcesDryRun}
          />
        </div>
      )}

      <div>
        <h2 className="mb-2 text-sm font-semibold text-(--text-muted)">
          Environment (secrets only)
        </h2>
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
            <p className="mt-2">
              However you trigger it, the worker is resumable: it drains queued
              work until it runs out of its time budget, then stops cleanly and
              picks up where it left off. Running it repeatedly is safe, and is
              how you flush a backlog faster than the daily cron would.
            </p>
          </details>
          <EnvRow name="TURSO_DATABASE_URL" hint="libSQL/Turso database URL" fallback="local ./local.db file" />
          <EnvRow name="TURSO_AUTH_TOKEN" hint="Turso token; required whenever the URL is remote" />
          <EnvRow required name="GMAIL_USER" hint="Gmail address that sends applications, outreach and follow-ups" />
          <EnvRow required name="GMAIL_APP_PASSWORD" hint="16-char app password, not your normal Gmail password" />
          <EnvRow name="OWNER_EMAIL" hint="Where the digest gets sent" fallback="GMAIL_USER" />
          {/*
            DRY_RUN is the one operational value still listed here, because it
            is the only one env can still influence -- it forces dry-run on and
            can never turn it off. Everything else that used to be in this list
            moved to Pipeline settings above; leaving those rows would show
            "not set" for values that ARE configured, just not here.
          */}
          <EnvRow name="DRY_RUN" hint="Deploy-level stop. Forces dry-run on; cannot be lifted from the dashboard" fallback="off (the Settings toggle decides)" />
          <EnvRow name="ENCRYPTION_KEY" hint="Encrypts stored mailbox passwords; openssl rand -hex 32. Without it, mailbox setup is refused" />
          <EnvRow name="IMAP_USER" hint="Inbox read for job alerts" fallback="GMAIL_USER" />
          <EnvRow name="IMAP_PASSWORD" hint="The same app password works for IMAP" fallback="GMAIL_APP_PASSWORD" />
          <EnvRow name="ANTHROPIC_API_KEY" hint="AI-written drafts instead of the built-in templates" />
          <EnvRow name="ADZUNA_APP_ID" hint="Adzuna source is skipped unless BOTH key vars are set" />
          <EnvRow name="ADZUNA_APP_KEY" hint="See above" />
          <EnvRow name="NEXT_PUBLIC_APP_URL" hint="Your deployed URL. Inlined at build time, so it cannot be a runtime setting" />
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
