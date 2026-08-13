# Job & Freelance BDE Pipeline

A Next.js app that finds remote-friendly jobs and freelance/contract leads daily, scores them
against Ribhu Gautam's resume, drafts a tailored cover letter or pitch for each, auto-sends the
ones it safely can, and queues the rest for a one-click approval from a dashboard.

## What this actually does (and doesn't)

**Fully automated, no human in the loop:**
- Fetches from RemoteOK, Remotive, Arbeitnow, We Work Remotely, Himalayas, Jobicy, Adzuna
  (optional key), and your own LinkedIn job-alert emails.
- Collapses the same job appearing on several boards into one row, so one real vacancy produces
  one score and one cover letter rather than five.
- Recovers the job description for LinkedIn alerts by fetching the public job page, so those roles
  are scored on the same evidence as everything else.
- Scores every job/lead against the resume in `lib/domain/scoring/resume-profile.ts`.
- Drafts a tailored cover letter/pitch per match, referencing real experience and links only.
- Auto-sends by email **only** when the listing itself publishes a plain apply-by-email address —
  never guessed, never inferred.
- Watches your inbox for replies, matches them to the exact thread by `Message-ID`, and advances
  the pipeline status automatically.
- Sends one follow-up at day 4 and a final one at day 10 to anything that got no reply, and stops
  the sequence the moment someone responds.
- Sends a digest summarizing what happened and what needs a click.

**Needs exactly one keystroke from you:**
- LinkedIn and other portal applications. The dashboard queues them scored, with the letter
  written; `Enter` opens the apply page with that letter already on your clipboard.

**Deliberately NOT automated, and why:**
- **No bot auto-apply on LinkedIn.** No headless browser drives the account. LinkedIn's detection
  is mostly server-side — application velocity, timing distributions, session/IP consistency, and
  recruiters reporting templated applications — so client-side stealth does not deliver what it
  promises, and the account at risk is the one recruiters use to reach you. The click is also not
  the expensive part of a job search; everything upstream of it is, and all of that is automated
  here.
- **No anti-detection tooling of any kind** — no fingerprint spoofing, no stealth drivers, no proxy
  rotation. Not built, and not a gap to be filled later.
- **No automated LinkedIn connection requests or InMail.** Outbound automation is what LinkedIn's
  anti-bot systems target hardest, and it is visible to third parties rather than just to you.
- **No outreach without a verified reply channel.** A lead with no published contact email is
  queued for you to pitch through that platform's own messaging.

The LinkedIn enrichment fetch is worth being precise about: it is an unauthenticated GET of a public
page, with no login, no cookie and no session. No account is involved, so there is no account to
restrict. If LinkedIn rate-limits it, the job silently falls back to title-only scoring — the
behavior this system had before enrichment existed.

## Known limitations / things to verify before relying on this

- The source fetchers were originally verified against mocked data rather than live endpoints.
  Watch the first few digests for parsing errors — job-board APIs change shape occasionally, and a
  source that starts failing is reported in the digest rather than failing silently.
- **Upwork RSS is disabled by default** (`ENABLE_UPWORK_RSS=0`). Confirm the feed URL in
  `lib/infra/sources/upwork.ts` returns real results in a browser before enabling it.
- The scorer (`lib/domain/scoring/score.ts`) is a weighted keyword matcher, not an LLM judge —
  fast and free, but it will occasionally rank things oddly. Tune the weights in
  `lib/domain/scoring/resume-profile.ts` against real results.
- **Tech-adjacent roles can clear the bar.** Developer Advocate, QA Engineer and similar score in
  the 40s because their descriptions name-drop the same stack a real posting does. They are
  deliberately *not* filtered out — whether those are interesting is your call, not the system's.
  Unambiguously non-engineering titles (sales, marketing, recruiting, account executive, customer
  success, solutions consultant) are excluded by `ROLE_VETO_PHRASES`. Add to that list as you see
  real results.
- **Don't lower `MATCH_THRESHOLD` below 40 without measuring.** It looks like there is empty space
  between the noise and the targets; there isn't. The 29–46 band is densely filled with
  tech-adjacent roles. Dropping to 30 was measured as admitting 3 real targets and 6 irrelevant
  ones. The reasoning and the full score table are in
  `docs/superpowers/specs/2026-08-13-pipeline-restructure-design.md`.
- Some genuinely good roles score ~23 as title-only rows (bare "Software Engineer", "Founding
  Engineer"). No threshold rescues those without letting the noise in — they need enrichment to
  recover a description, which is what the enrich stage is for.
- The LinkedIn alert-email parser is inherently fragile: LinkedIn changes those templates without
  notice. It is covered by fixture tests so a break shows up in CI rather than as a quietly empty
  source, but the fixtures can only encode templates we have seen.
- **Double check the LinkedIn URL** in `lib/domain/scoring/resume-profile.ts` — the resume PDF says
  `linkedin/ribhugautam` but the link given separately was `ribhugutam` (no second "a"). It
  defaults to the resume's spelling; fix it if that is the typo instead.

## Architecture

```
lib/config/env.ts          zod-validated env; the ONLY place process.env is read
lib/domain/                pure logic — no I/O, no DB, no network, no env
  types.ts                 RawJob / RawLead
  scoring/                 resume profile + the 0-100 fit scorer
  dedupe/fingerprint.ts    cross-source identity: one vacancy, one row
  drafting/compose.ts      cover letters, pitches, follow-ups
lib/infra/                 I/O adapters, one concern each
  db/                      client, schema, documents, migrations/
  mail/                    send (SMTP), imap (read-only), replies (Message-ID matching)
  sources/registry.ts      every source with its enable rule, in one list
  linkedin/                alerts.ts (parse alert email) + enrich.ts (public page fetch)
lib/pipeline/
  state.ts                 stages, statuses, retry/backoff rules
  stages/                  ingest enrich score draft dispatch watch followup digest
  worker.ts                the time-budgeted drain loop
app/api/cron/daily         entrypoint, protected by CRON_SECRET (bearer header only)
app/api/actions/*          approve & send / status-update endpoints the dashboard calls
app/dashboard/*            the pipeline board UI
```

`domain/` never imports from `infra/`. That one-way rule is what lets scoring, deduping and
drafting be unit-tested with plain data and no fixtures.

### The pipeline is a resumable stage machine

Work is rows moving through states, not one long function. Each row carries a `stage` (what to do
next) and a `status` (what a human sees). A worker drains batches while it has wall-clock budget:

```
while (timeRemaining() > RESERVE) {
  const batch = await claimNextBatch()
  if (!batch) break
  await runStage(batch)      // a per-item failure marks that item, never the run
}
```

Whatever is left waits for the next invocation. This is why the system survives unattended: a
timeout or crash loses one batch rather than the run, a slow source cannot starve a fast one, and
an item that keeps failing backs off exponentially and gets reported in the digest instead of
retrying forever or vanishing.

It also makes the cron cadence a tuning knob rather than a correctness requirement. The committed
`vercel.json` runs once daily, which suits Vercel's Hobby plan. If you are on Pro, change the
schedule to `*/15 * * * *` and the same code drains continuously — no other change needed. If a run
ends with work still queued it sets `budgetExhausted` on the digest row, which is your signal that
the cadence is too slow for the volume.

## Database: Turso (libSQL / SQLite)

The DB is **SQLite**, via [Turso](https://turso.tech). Two modes, one codebase:

- **Local dev** - set no DB env vars at all. `lib/infra/db/client.ts` falls back to a real SQLite file
  at `./local.db`. Nothing to install, no server to run.
- **Production** - set `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` and the exact same code talks to
  Turso over HTTP.

Why this and not Postgres:

- **No connection pool to exhaust.** The libSQL driver is stateless HTTP. A `pg.Pool` on Vercel
  opens a fresh pool per cold-started lambda and hits Postgres connection limits under any
  concurrency; this design cannot.
- **Free tier headroom** - 5 GB storage / 500M row reads per month, vs 512 MB on Neon's free plan
  and 500 MB on Supabase's.
- **No idle-pause risk.** Supabase pauses free projects after ~a week of low activity, which is a
  bad failure mode for a system whose whole job is to run unattended every day.

Caveats worth knowing: Turso is a smaller company than Neon, and it had a free-tier data-loss
incident in Dec 2023 (publicly disclosed). The data here is largely reconstructible - job listings
get re-fetched - but your *sent* history is not, so consider a periodic `turso db dump`.
Escape hatch: it's a SQLite file, so `turso db dump` moves you to any SQLite host, any day.

Drizzle (not Prisma) is used as the ORM - Prisma's engine binaries are fetched from
`binaries.prisma.sh`, which this sandbox's network egress rules block, so Drizzle (pure JS, no
native binary) was used instead. This isn't a compromise - Drizzle's SQLite support is first-class.
You also get a free table-editor UI with `npm run db:studio`.

## Access control

The whole deployment is private. `proxy.ts` gates every route and every API
endpoint behind a single password; unauthenticated browsers are redirected to
`/login` and unauthenticated API calls get a `401`. This matters because the
dashboard exposes your resume, your inbox-derived job alerts, and the ability to
send email as you.

- **`APP_PASSWORD`** - the one password that unlocks the app. Minimum 12 characters.
- **`AUTH_SECRET`** - random string (`openssl rand -hex 32`) used to sign the session
  cookie. Rotating it instantly signs out every browser.

Both are required. If either is missing or `APP_PASSWORD` is shorter than 12 characters,
the app **fails closed**: every route returns `503`, including the login page. It will
never fall open.

Signing in sets an `HttpOnly`, `Secure`, `SameSite=Lax` cookie valid for 30 days,
holding only an expiry timestamp and its HMAC - there is no server-side session store.
"Sign out" in the dashboard header clears it.

Two routes are intentionally outside the password gate:

- `/login` and `/api/auth/*` - otherwise you could never sign in.
- `/api/cron/daily` - Vercel Cron cannot send your browser cookie. It is protected
  separately by `CRON_SECRET` (bearer header, fail-closed if unset). **This is the one
  publicly reachable route that does real work, so `CRON_SECRET` must be a long random
  value, not a guessable one.**

There is no password reset and no second user. If you lose the password, change
`APP_PASSWORD` in Vercel and redeploy.

## Deploying

1. **Push to GitHub.** Unzip this project, `git init` if needed, create a new empty repo on your
   GitHub account, and push.
2. **Import into Vercel.** vercel.com -> Add New -> Project -> import the repo. Framework preset
   Next.js is auto-detected.
3. **Create the Turso database** (once, from your own machine):
   ```bash
   npm i -g turso
   turso auth signup
   turso db create job-bde-system
   turso db show job-bde-system --url        # -> TURSO_DATABASE_URL
   turso db tokens create job-bde-system     # -> TURSO_AUTH_TOKEN
   ```
4. **Set the remaining env vars** in Project Settings -> Environment Variables, using
   `.env.example` as the checklist. Do this directly in the Vercel dashboard, not by pasting
   secrets into any chat - App Passwords and API keys should never leave your own accounts.
5. **Apply the DB migrations**: locally, with `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` set in your
   `.env`, run `npm run db:migrate`. Migrations are committed under
   `lib/infra/db/migrations/`, so production schema changes are versioned and repeatable.

   That script is `scripts/migrate.ts`, not `drizzle-kit migrate`. The CLI silently no-ops against
   a `file:` URL under this config — exits 0, prints a spinner, creates nothing — and a migration
   tool that reports success without doing anything is worse than one that fails, because you only
   find out later via "no such table". The script uses drizzle's programmatic migrator, builds its
   client exactly the way the app does, and reads the schema back at the end to prove the tables
   exist before claiming success.

   Schema changes are a two-step: edit `lib/infra/db/schema.ts`, run `npm run db:generate` to
   produce the SQL, commit it, then `npm run db:migrate` to apply. CI fails if a schema edit is
   committed without its generated migration.
6. **Redeploy** so the new env vars take effect.
7. **Verify**: open `/dashboard/settings` on your deployed URL to confirm every env var shows
   "set", then manually trigger a run once via
   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" https://your-app.vercel.app/api/cron/daily
   ```
   and check `/dashboard` for the run log and your inbox for the digest. (The secret must go in
   the header - it is deliberately not accepted as a `?secret=` query param, because query
   strings are written to Vercel's request logs in plaintext.)
8. The cron in `vercel.json` runs daily at 04:00 UTC (~9:30am IST) - edit the schedule if you want
   a different time. Note: Vercel Hobby plan cron jobs may fire within an hour of the scheduled
   time rather than exactly on it; Pro plan cron is exact.

## Local development / testing

```bash
npm install
npm run dev
```

With no DB env vars set the app uses a local `./local.db` SQLite file — nothing to install, no
server to run.

```bash
npm run verify      # lint + typecheck + test, the same gate CI enforces
npm run test        # unit tests only
npm run test:watch  # while working
```

The unit tests need no database, no network and no credentials: `lib/domain/**` is pure, and the
infra tests stub `fetch` and IMAP. Anything that would make a real network call in a test is a bug
in the test.

To exercise scoring + drafting + persistence end to end against a real local SQLite file without
sending email:

```bash
npm run db:migrate
npm run smoke
```

Set `DRY_RUN=1` to run the full pipeline — fetching, scoring, drafting, everything written to the
dashboard — while sending zero email, including the digest. Leave it on until you have read a few
generated drafts.
