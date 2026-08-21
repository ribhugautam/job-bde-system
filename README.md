# Job & Freelance BDE Pipeline

A Next.js app that finds remote-friendly jobs and freelance/contract leads daily, scores them
against Ribhu Gautam's resume, drafts a tailored cover letter or pitch for each, auto-sends the
ones it safely can, and queues the rest for a one-click approval from a dashboard.

## What this actually does (and doesn't)

**Fully automated, no human in the loop:**
- Fetches from RemoteOK, Remotive, Arbeitnow, We Work Remotely, Himalayas, Jobicy, Adzuna, Y Combinator
- Reads job-alert emails from your own inbox, read-only: LinkedIn, Wellfound, Indeed
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
- **Upwork RSS is retired** (2026-08-21). Upwork removed its public RSS job feeds; the endpoint
  answers `410 Gone`, which is permanent. The `ENABLE_UPWORK_RSS` flag has been removed — there is
  nothing to enable. The registry keeps an `upwork_rss` tombstone because that name is half the
  `(source, source_id)` dedupe key and deleting it would orphan every lead already stored under it.
  Freelance leads now come from `arbeitnow_contract` and `wwr_contract` only.
- The scorer (`lib/domain/scoring/score.ts`) is a weighted keyword matcher, not an LLM judge —
  fast and free, but it will occasionally rank things oddly. Tune the weights in
  `lib/domain/scoring/resume-profile.ts` against real results.
- **Tech-adjacent roles can clear the bar.** Developer Advocate, QA Engineer and similar score in
  the 40s because their descriptions name-drop the same stack a real posting does. They are
  deliberately *not* filtered out — whether those are interesting is your call, not the system's.
  Unambiguously non-engineering titles (sales, marketing, recruiting, account executive, customer
  success, solutions consultant) are excluded by `ROLE_VETO_PHRASES`. Add to that list as you see
  real results.
- **Don't lower the match threshold below 40 without measuring** (Settings → Matching). It looks like there is empty space
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
endpoint; unauthenticated browsers are redirected to `/login` and unauthenticated
API calls get a `401`. This matters because the dashboard exposes people's
resumes, their inbox-derived job alerts, and the ability to send email as them.

### Accounts

Each person has their own account. **Registration is invite-only** — this app
sits on a public URL and sends email on people's behalf, so "anyone who finds
the login page" is not an acceptable population.

- An **admin** invites someone from `/dashboard/team` and sends them the
  one-time link it produces. The link works once and expires after 7 days.
- **There is no self-signup and no password reset.** An admin can deactivate an
  account; deactivation is a flag, never a delete, because applications and
  outreach are a record of email that really was sent and removing the sender
  would strand them.

**The first admin is created for you.** `npm run db:migrate` seeds it from
`OWNER_EMAIL` + `APP_PASSWORD`, because the migration that creates the `users`
table is the exact moment `APP_PASSWORD` stops working on its own — and with
invite-only registration there would otherwise be nobody able to issue the first
invite. Sign in with those, then invite everyone else.

`APP_PASSWORD` is legacy after that point: it seeds the first admin and is no
longer accepted as a login on its own.

### The two env vars the gate needs

- **`APP_PASSWORD`** — minimum 8 characters, **random rather than a word**. The
  login route throttles at 10 attempts per minute per IP+email, but that counter
  is per warm serverless instance rather than global, so it is a speed bump and
  not a real rate limiter: 8 random characters are far out of brute-force reach,
  an 8-letter dictionary word is not. `openssl rand -base64 12` produces
  something suitable.
- **`AUTH_SECRET`** — random string (`openssl rand -hex 32`) used to sign the
  session cookie. Rotating it instantly signs out every browser.

Both are required. If either is missing or too short, the app **fails closed**:
every route returns `503`, including the login page. It will never fall open. The
503 page names which variable is at fault and whether it is absent or merely too
short — it does not just say "set these", because a value that is set but one
character under the limit is otherwise indistinguishable from a missing one, and
that costs an afternoon.

Both limits live in `lib/config/auth-policy.ts` and are enforced in two places — the Edge
gate in `lib/infra/auth.ts` and startup validation in `lib/config/env.ts`. They import the
same constants so the two can never disagree; a test asserts it.

### How a request is authorized, in two layers

Signing in sets an `HttpOnly`, `Secure`, `SameSite=Lax` cookie valid for 30 days,
holding a user id, an expiry, and their HMAC — there is no server-side session
store. "Sign out" in the dashboard header clears it.

Those two layers are **not redundant**, and the distinction is the most likely
place for a future authorization bug:

1. **`proxy.ts`, on the Edge** — proves the cookie is a genuine, unexpired token
   this deployment issued. It cannot reach the database, so it cannot know
   whether that user still exists or is still active. A deactivated person's
   cookie stays *cryptographically* valid until it expires.
2. **`getSessionUser()` in `lib/infra/session.ts`** — loads the row and rejects
   anyone deleted or deactivated. It is the **only** sanctioned way to learn who
   is calling. Reading the cookie directly anywhere else silently re-opens the
   gap in whichever route did it.

Three routes are intentionally outside the gate:

- `/login` and `/api/auth/login|logout` — otherwise you could never sign in.
- `/invite/[token]` and `/api/auth/accept-invite` — accepting an invite happens
  with no session by definition. The token in the URL is the credential, and it
  is checked for being unexpired, unspent and unrevoked.
- `/api/cron/daily` — Vercel Cron cannot send your browser cookie. It is protected
  separately by `CRON_SECRET` (bearer header, fail-closed if unset). **This is the one
  publicly reachable route that does real work, so `CRON_SECRET` must be a long random
  value, not a guessable one.**

### Sending identity

Each person configures their own mailbox on `/dashboard/settings`; the app
password is encrypted at rest with `ENCRYPTION_KEY` (a **separate** var from
`AUTH_SECRET`, so rotating a signing key cannot destroy stored credentials).

**Auto-send stays off until a mailbox is saved *and* verified.** Until then that
person's applications are drafted and queued for one-click sending. Nothing can
go out under the wrong name — `sendMail()` requires an explicit sender and has no
fallback address.

## Where configuration lives

Two places, and the split is deliberate:

- **`.env`** — secrets, infrastructure, and anything read before a database
  connection exists. About 15 variables. See `.env.example`.
- **Settings → Pipeline settings** — everything operational: match threshold,
  which sources run, follow-up cadence, worker limits, staleness window. Admin
  only, changeable without a redeploy.

These used to all be environment variables, which meant a Vercel edit and a
deploy to change a number — slow enough that nothing ever got tuned.

`npm run db:migrate` **seeds the settings row from your current environment**, so
deploying this changes nothing about how the pipeline behaves. Those variables
are then ignored, and the settings page lists any that are still set so you can
delete them.

One exception. `DRY_RUN` exists in both places, and env can only ever force it
**on**:

```
effective dry run = DRY_RUN in env  OR  the Settings toggle
```

The toggle gives one-click control day to day. `DRY_RUN=1` in the environment is
a deploy-level stop that no dashboard session can undo — including one belonging
to an admin who has been compromised, or who clicked the wrong thing.

## How the job list works

There are no filters. The list is ranked against **your** resume, and split into
three piles:

| Pile | What is in it |
|---|---|
| **Inbox** | New to you and not yet triaged, best match first |
| **Working** | Jobs you kept, applied to, or are interviewing for |
| **Archive** | Ones you dismissed, or that timed out before you got to them |

Everyone shares the same pool of ingested jobs, but triage is private: a
colleague dismissing a job never hides it from you.

Untriaged jobs leave the Inbox after the staleness window (Settings → Matching, default 30 days). Nothing is
deleted and nothing is written when you change that number — staleness is
computed when the page is read, so raising or lowering it reflows every pile
instantly and reversibly.

Ranking comes from your profile at `/dashboard/profile`, which is filled in
automatically from your uploaded CV and is editable. Preferences that used to be
filter chips ("remote only") live there now and shape the *order* instead of
hiding things, so a strong hybrid role can still out-rank a mediocre remote one.

**Known limitation:** location eligibility is judged against India for everyone,
because it is computed once per job at ingest rather than per viewer. Correct for
a team hiring from India; wrong for anyone else.

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

Leave **dry run** on (Settings → Sending) until you have read a few generated drafts: the full
pipeline runs — fetching, scoring, drafting, everything written to the dashboard — while sending
zero email, including the digest.

`DRY_RUN=1` in the environment does the same thing but cannot be switched off from the dashboard.
Use the toggle day to day; use the variable when you want a stop nobody can lift.
