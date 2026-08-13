# Job & Freelance BDE Pipeline

A Next.js app that finds remote-friendly jobs and freelance/contract leads daily, scores them
against Ribhu Gautam's resume, drafts a tailored cover letter or pitch for each, auto-sends the
ones it safely can, and queues the rest for a one-click approval from a dashboard.

## What this actually does (and doesn't)

**Does, fully automated:**
- Daily fetch from RemoteOK, Remotive, Arbeitnow, and We Work Remotely (all public, key-free APIs/RSS feeds - no ToS risk).
- Scores every job/lead against the resume in `lib/resumeData.ts` and ranks by fit.
- Drafts a tailored cover letter/pitch per match, referencing real experience and links only.
- Auto-sends the application/pitch by email **only** when the listing itself publishes a plain
  apply-by-email address - never guessed, never inferred.
- Sends a daily digest email summarizing what happened and what needs a click.

**Deliberately NOT automated, and why:**
- **LinkedIn / Indeed / most company portals**: no bot auto-apply. These platforms block automated
  submissions and ban accounts that try - not worth the risk to Ribhu's actual LinkedIn account,
  which he needs for real networking and interviews. Jobs from these sources are queued
  "ready for review" with a drafted cover letter to paste in, not auto-clicked-through.
- **Scraping LinkedIn contacts for outreach**: not implemented, same ToS/ban risk. Freelance/contract
  leads come from public job-board contract listings and (optionally) Upwork's RSS search feeds
  instead.
- **Sending outreach with no verified reply channel**: if a lead has no published contact email, it's
  queued for you to pitch manually through that platform's own messaging.

## Known limitations / things to verify before relying on this

- This was built in a sandboxed cloud container whose network egress blocks the real job-board
  hosts (remoteok.com, remotive.com, arbeitnow.com, weworkremotely.com all returned "host not in
  allowlist" here). The fetchers were verified with mocked data (`scripts/smoke-test.ts`) against a
  real local SQLite database, and the full route was verified to run end-to-end without crashing - but the
  *live* API/RSS response shapes could not be checked from here. Once deployed to Vercel (which has
  normal internet access), watch the first couple of digest emails/dashboard runs for parsing
  errors and tell me if a source's fields look wrong - job-board APIs occasionally change shape.
- **Upwork RSS is disabled by default** (`ENABLE_UPWORK_RSS=0`). I could not confirm the feed URL
  Upwork has historically published still works, or still returns anything without auth, from this
  sandbox. Test the URL in `lib/sources/upwork.ts` in a browser first; only flip it on once you've
  confirmed it returns real results.
- Himalayas and a couple of other aggregators were deliberately left out rather than guessing at an
  unverified API shape - easy to add later once you (or I, in a future session with unrestricted
  network access) confirm the actual endpoint.
- The matching/scoring logic (`lib/matcher.ts`) is a weighted keyword scorer, not an LLM judge - it's
  fast and free but will occasionally rank things oddly. Tune the weights in `lib/resumeData.ts` as
  you see real results.
- **Double check the LinkedIn URL** in `lib/resumeData.ts` - the resume PDF says
  `linkedin/ribhugautam` but the link given separately was `ribhugutam` (no second "a"). I defaulted
  to the resume's spelling; fix it if that's the typo instead.

## Architecture

```
lib/resumeData.ts     structured resume: skills, experience, projects, links
lib/sources/*.ts       one fetcher per job board / feed, all fail-safe (a broken source never
                        takes down the run - see safeFetchSource in lib/sources/types.ts)
lib/matcher.ts         scores jobs/leads 0-100 against the resume
lib/drafts.ts          generates cover letters / pitches (template, or Claude if
                        ANTHROPIC_API_KEY is set)
lib/mailer.ts           sends mail via Gmail SMTP (app password)
lib/pipeline.ts        the daily orchestration: fetch -> dedupe -> score -> draft -> auto-send
                        where safe -> digest email
lib/db/schema.ts        Drizzle ORM schema (SQLite/libSQL): jobs, leads, applications, outreach,
                        digest_logs
app/api/cron/daily      the single daily entrypoint, protected by CRON_SECRET
app/api/actions/*       manual "approve & send" / status-update endpoints the dashboard calls
app/dashboard/*         the pipeline board UI
```

## Database: Turso (libSQL / SQLite)

The DB is **SQLite**, via [Turso](https://turso.tech). Two modes, one codebase:

- **Local dev** - set no DB env vars at all. `lib/db/client.ts` falls back to a real SQLite file
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
5. **Push the DB schema**: locally, with `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` set in your
   `.env`, run `npm run db:push`. This creates the five tables in your Turso database.
6. **Redeploy** so the new env vars take effect.
7. **Verify**: open `/dashboard/settings` on your deployed URL to confirm every env var shows
   "set", then manually trigger a run once via
   `GET https://your-app.vercel.app/api/cron/daily?secret=YOUR_CRON_SECRET` and check
   `/dashboard` for the run log and your inbox for the digest.
8. The cron in `vercel.json` runs daily at 04:00 UTC (~9:30am IST) - edit the schedule if you want
   a different time. Note: Vercel Hobby plan cron jobs may fire within an hour of the scheduled
   time rather than exactly on it; Pro plan cron is exact.

## Local development / testing

```bash
npm install
npm run dev
```

To exercise the scoring + drafting + DB logic without hitting real job APIs or sending real email:

```bash
# with no DB env vars set, this uses a local ./local.db SQLite file
npm run db:push
npm run smoke
```
