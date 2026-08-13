import { LINKS } from "@/lib/resumeData";

export const dynamic = "force-dynamic";

function EnvRow({ name, hint }: { name: string; hint: string }) {
  const set = Boolean(process.env[name]);
  return (
    <div className="flex items-center justify-between border-b border-neutral-900 py-2 text-sm">
      <div>
        <div className="font-mono text-xs">{name}</div>
        <div className="text-xs text-neutral-500">{hint}</div>
      </div>
      <span className={set ? "text-emerald-400" : "text-red-400"}>{set ? "set" : "missing"}</span>
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
            ? "border-amber-700 bg-amber-950/30"
            : "border-red-800 bg-red-950/30"
        }`}
      >
        <div className="text-sm font-semibold">
          {dryRun ? "DRY RUN — no email will be sent" : "LIVE — email will be sent automatically"}
        </div>
        <div className="mt-1 text-xs text-neutral-400">
          {dryRun
            ? "The daily run drafts applications and pitches into the dashboard only. Nothing leaves your Gmail, including the digest. Set DRY_RUN=0 (or remove it) to go live."
            : "Applications auto-send to any listing that publishes an apply-by-email address, and outreach auto-sends up to the daily cap. Set DRY_RUN=1 to draft without sending."}
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-neutral-300">Environment</h2>
        <div className="rounded border border-neutral-800 p-3">
          <EnvRow name="TURSO_DATABASE_URL" hint="libSQL/Turso database URL (unset = local ./local.db file)" />
          <EnvRow name="TURSO_AUTH_TOKEN" hint="Turso token; required whenever the URL is remote" />
          <EnvRow name="GMAIL_USER" hint="Gmail address that sends applications & outreach" />
          <EnvRow name="GMAIL_APP_PASSWORD" hint="16-char app password, not your normal Gmail password" />
          <EnvRow name="OWNER_EMAIL" hint="Where the daily digest gets sent (defaults to GMAIL_USER)" />
          <EnvRow name="CRON_SECRET" hint="Protects /api/cron/daily from public calls" />
          <EnvRow name="ANTHROPIC_API_KEY" hint="Optional - AI-written drafts instead of the template" />
          <EnvRow name="OUTREACH_DAILY_CAP" hint="Optional - defaults to 10 auto-sent pitches/day" />
          <EnvRow name="ENABLE_UPWORK_RSS" hint="Optional, experimental - set to 1 only after verifying the feed" />
          <EnvRow name="NEXT_PUBLIC_APP_URL" hint="Your deployed URL, used in the digest email" />
          <EnvRow name="DRY_RUN" hint="Set to 1 to draft without sending any email (see banner above)" />
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-neutral-300">Links used in drafts — verify these</h2>
        <div className="rounded border border-neutral-800 p-3 text-sm space-y-1">
          <div>LinkedIn: {LINKS.linkedin} <span className="text-emerald-400 text-xs">(confirmed)</span></div>
          <div className="text-neutral-500">
            GitHub: {LINKS.github}{" "}
            <span className="text-amber-400 text-xs">
              (excluded from all outreach — pinned repos are student projects. Repin, then re-add it in lib/drafts.ts)
            </span>
          </div>
          <div>Portfolio: {LINKS.portfolio}</div>
          <div>Ziro: {LINKS.ziro}</div>
          <div>Email: {LINKS.email}</div>
        </div>
        <p className="mt-2 text-xs text-neutral-500">
          Edit lib/resumeData.ts to fix any of these — they flow straight into every cover letter and pitch.
        </p>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-neutral-300">Manual run</h2>
        <p className="text-sm text-neutral-400">
          Trigger the daily pipeline on demand (useful for testing) by visiting:
        </p>
        <pre className="mt-2 rounded bg-neutral-900 p-3 text-xs text-neutral-300">
          GET {process.env.NEXT_PUBLIC_APP_URL || "https://your-app.vercel.app"}/api/cron/daily?secret=YOUR_CRON_SECRET
        </pre>
      </div>
    </div>
  );
}
