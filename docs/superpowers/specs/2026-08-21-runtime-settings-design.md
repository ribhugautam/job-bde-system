# Runtime settings: move operational config out of env

Date: 2026-08-21
Status: approved (design), pending implementation

## Problem

`.env` holds 35 variables. Roughly 15 are genuine secrets; the other 20 are
operational tuning an admin should be able to change without a redeploy —
match threshold, source toggles, follow-up cadence, worker limits, staleness
window.

Two costs. Changing any of them means editing Vercel environment variables and
redeploying, which is slow enough that nobody tunes anything. And the file is
long enough that the values which genuinely *are* secret do not stand out.

Now that the system is live with multiple users, the second cost is the one
that matters more.

## Decisions

| Question | Decision |
|---|---|
| Where do operational values live | A settings row in the database, edited by admins |
| What stays in env | Secrets, infra, and anything read before the DB exists |
| Precedence | The database wins once set; env seeds it on migration |
| `DRY_RUN` | Settings, **but env can force it on** — env may only make things safer |
| Who can edit | Admins only |

## What moves, and what cannot

**Stays in env** — secret, or needed before a database connection exists:
`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `APP_PASSWORD`, `AUTH_SECRET`,
`ENCRYPTION_KEY`, `CRON_SECRET`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`,
`IMAP_USER`, `IMAP_PASSWORD`, `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`,
`ANTHROPIC_API_KEY`, `OWNER_EMAIL`.

`NEXT_PUBLIC_APP_URL` also stays, for a different reason: Next inlines it at
**build** time, so it physically cannot come from a database.

**Moves to settings** — 18 operational values: `MATCH_THRESHOLD`,
`JOB_STALE_DAYS`, `DRY_RUN`, `ENABLE_LINKEDIN_ALERTS`,
`ENABLE_WELLFOUND_ALERTS`, `ENABLE_INDEED_ALERTS`, `LINKEDIN_ALERT_DAYS`,
`ENABLE_LINKEDIN_ENRICH`, `LINKEDIN_ENRICH_DAILY_CAP`,
`LINKEDIN_ENRICH_DELAY_MS`, `ENABLE_FOLLOWUPS`, `FOLLOWUP_FIRST_DAYS`,
`FOLLOWUP_FINAL_DAYS`, `FOLLOWUP_DAILY_CAP`, `WORKER_TIME_BUDGET_MS`,
`WORKER_BATCH_SIZE`, `OUTREACH_DAILY_CAP`, and the non-secret IMAP fields
(`IMAP_HOST`, `IMAP_PORT`, `IMAP_MAILBOX`).

## Design

### 1. Storage

`app_settings`: a singleton row (`id = 1`) holding a JSON blob, plus
`updatedByUserId` and `updatedAt`.

JSON rather than typed columns, so adding a setting needs no migration and the
**same zod schema** validates the stored blob that validates env today — one
source of truth for defaults and bounds. Parsing is total, in the style of
`buildProfile`: a corrupted row degrades to defaults rather than breaking every
page.

One row rather than key/value pairs because settings validate as a *set*
(`FOLLOWUP_FINAL_DAYS > FOLLOWUP_FIRST_DAYS` is a cross-field rule), and one row
means one read and no partial-write races.

### 2. Two config layers

- `lib/config/env.ts` — synchronous, `process.env` only, **secrets and infra**.
- `lib/config/settings.ts` — the zod schema, defaults and bounds for operational
  values. Pure; no database.
- `lib/infra/db/settings.ts` — `getSettings()` / `saveSettings()` / seeding.

`AppConfig = Secrets & Settings`, assembled once per run or request.

**`ctx.env` is renamed to `ctx.config`.** A mechanical rename, and worth it:
`ctx.env.MATCH_THRESHOLD` would send a reader to Vercel to look for a value that
now lives in the database.

### 3. Precedence, and the DRY_RUN exception

The database wins once set. The migration seeds the settings row from current
env values, so **behavior does not change on deploy**. Those env vars then
become inert.

`DRY_RUN` is the exception and the reason it is stated separately:

```
effectiveDryRun = envDryRun || settingsDryRun
```

Env can only ever force it **on**. Day to day it is a one-click toggle; a
deploy-level `DRY_RUN=1` is a stop that no admin account — compromised,
mistaken, or otherwise — can undo from the dashboard.

### 4. Inert env vars must be visible

After this ships, setting `MATCH_THRESHOLD` in Vercel does nothing. That is
exactly the failure mode this codebase already works to prevent — it is why the
auth 503 page names the specific variable instead of saying "set these".

So the settings page lists any moved variable that is **still set in the
environment**, saying plainly that it is ignored and managed here now.

### 5. Threading it through

23 `getEnv()` call sites. Most read secrets and are unaffected.

- **Pipeline**: resolved once per run onto `ctx.config`; stages are unchanged
  apart from the rename.
- **Source registry**: `enabled: () => boolean` becomes
  `enabled: (s: Settings) => boolean`, and `fetch` likewise. TypeScript accepts
  a zero-argument function where a one-argument one is expected, so only the
  sources that actually need settings change. This also **deletes the
  env-mutation juggling** in the registry test, which currently saves and
  restores six variables around every case.
- **Pages and routes**: `await getSettings()` where needed.

**No TTL cache.** One small row per run or render; React `cache()` dedupes
within a render. A stale settings cache is worse than a query — an admin would
toggle something and watch it not take effect.

### 6. Bounds worth fixing on the way

`WORKER_TIME_BUDGET_MS` currently validates up to 800,000ms on a function whose
`maxDuration` is 60s. In env that takes a deliberate edit; on a settings page it
is one click from a worker killed mid-write. Capped at **50,000ms**, which
leaves room for the 17s of internal reserves plus the digest.

`FOLLOWUP_FINAL_DAYS > FOLLOWUP_FIRST_DAYS` moves from a startup crash to a
save-time validation message, which is strictly better.

## Testing

- settings parsing is total: malformed JSON, wrong types and out-of-range values
  all degrade to defaults rather than throwing
- cross-field validation rejects `FINAL <= FIRST` at save time
- `DRY_RUN`: env true + settings false stays **on**; env false + settings true is
  on; both false is off
- seeding is idempotent and does not overwrite an edited row
- bounds are clamped, including the worker ceiling
- registry `enabled()` reads the settings it is handed, with no env mutation

## Delivery

1. Settings schema, table and seeding — no behavior change
2. Move the readers over, rename `ctx.env` to `ctx.config`
3. Admin UI plus inert-env warnings
4. Prune `.env.example` and the README

## Risks

- **The seed is the migration's load-bearing step.** If it does not run, every
  moved setting silently reverts to its default — including `MATCH_THRESHOLD`,
  which would change what gets drafted. Seeding runs inside `db:migrate` and is
  idempotent.
- **`DRY_RUN` becomes clickable.** Mitigated by the env ceiling and by recording
  who changed it.
- **A settings read now sits in the request path** for pages that need one. It is
  a single-row primary-key lookup, but it is a database call where there was
  none.
