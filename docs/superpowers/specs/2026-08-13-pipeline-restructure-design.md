# Job/BDE Pipeline — Structural Restructure + Full Automation

Date: 2026-08-13
Status: Approved, in implementation

## Goal

Two things, in one pass:

1. Make the project structurally correct — layered `lib/`, validated config,
   real dedupe, committed migrations, tests, CI.
2. Automate the pipeline end to end, including LinkedIn, up to but not past a
   single human keystroke per application.

## Decisions taken (and why)

**LinkedIn apply is assisted, not unattended.** The dashboard queues matched
LinkedIn jobs; one keystroke opens Easy Apply with the cover letter on the
clipboard. No headless browser drives the account, and no anti-detection layer
is built. Rationale: LinkedIn's detection is mostly server-side (application
velocity, timing distribution, session/IP graph, recruiter reports), so
client-side stealth does not deliver what it claims, and the account at risk is
the one recruiters use to make contact. Everything upstream of the click —
find, enrich, dedupe, score, draft, track, follow up — is fully automated and
carries no account risk.

**LinkedIn descriptions are recovered by unauthenticated fetch.** Alert emails
carry no description. The enrich stage fetches the public `/jobs/view/{id}`
page with no login, no cookie, and no session, spaced out and permanently
cached per job id. No account is involved, so nothing can be restricted; the
worst case is a 429 and silent degradation to today's title-only behavior.

**Replies are detected and follow-ups auto-send.** Matching is by RFC 5322
`Message-ID` captured at send time, checked against inbound `In-Reply-To` /
`References` — an exact match, not a sender heuristic. A reply cancels pending
follow-ups. Silence triggers one nudge at day 4 and a final at day 10, then
stops permanently.

**Scheduling is plan-agnostic.** A resumable stage machine drained by a
time-budgeted worker. Correct whether the cron fires once a day (Vercel Hobby,
the default committed here) or every fifteen minutes (Pro — a one-line change
in `vercel.json`).

## Architecture

Root layout is unchanged (`app/`, `components/`, `proxy.ts`). Only `lib/`
reorganizes, so `@/lib/*` imports keep resolving and the diff stays reviewable.

```
lib/
  config/env.ts            zod-validated env; the ONLY place process.env is read
  domain/                  pure logic, zero I/O, testable without a database
    scoring/
      resume-profile.ts    (was lib/resumeData.ts)
      score.ts             (was lib/matcher.ts)
    dedupe/fingerprint.ts  cross-source identity key
    drafting/compose.ts    (was lib/drafts.ts)
  infra/                   I/O adapters, one concern each
    auth.ts                (was lib/auth.ts)
    db/                    client, schema, documents, migrations/
    mail/
      send.ts              (was lib/mailer.ts); returns the Message-ID
      imap.ts              shared read-only IMAP connection
      replies.ts           inbound reply matching
    sources/               one file per board + registry.ts
    linkedin/
      alerts.ts            (was lib/sources/linkedin-alerts.ts) parse alert email
      enrich.ts            public job-page fetch
  pipeline/
    state.ts               stages, statuses, legal transitions
    stages/                ingest enrich score draft dispatch watch followup digest
    worker.ts              time-budgeted drain loop
```

`domain/` imports nothing from `infra/`. That constraint is what makes scoring,
fingerprinting, and drafting unit-testable with no fixtures beyond plain data.

### The stage machine

Work is rows moving through states, not an imperative script. The worker drains
a bounded batch per stage while wall-clock budget remains:

```
while (timeRemaining() > RESERVE) {
  const batch = await claimNextBatch()
  if (!batch) break
  await runStage(batch)      // per-item failure marks the item, never the run
}
```

Unfinished work is picked up by the next invocation. Every item carries
`stage`, `attempts`, and `lastError`. An item that keeps failing backs off
exponentially and is reported in the digest rather than retrying forever or
disappearing silently.

Stages:

| Stage | Does |
|---|---|
| `ingest` | fetch all sources, upsert with dedupe, `status=found` |
| `enrich` | recover missing descriptions (LinkedIn public page), rate-limited |
| `score` | score against resume → `matched` or `rejected` |
| `draft` | generate cover letter / pitch |
| `dispatch` | auto-send where an apply email is published; else queue for review |
| `watch` | IMAP scan, match replies to threads, advance status, cancel follow-ups |
| `followup` | send due follow-ups (day 4, day 10) |
| `digest` | summarize the run |

### Dedupe

A `fingerprint` column holds `normalize(company) + normalize(title) +
location bucket`. Two indexes: unique on `(source, source_id)`, non-unique on
`fingerprint`.

The unique index turns ingest into `INSERT … ON CONFLICT DO NOTHING`, which
both removes the current N+1 (one SELECT per raw listing over stateless HTTP)
and makes ingest idempotent — the existing code is only safe because nothing
retries it yet.

On a fingerprint collision the row **merges** instead of duplicating: keep the
richest description, append to a `sources` array. This is what stops one job
becoming three cover letters, and it doubles as free enrichment whenever a
LinkedIn job is cross-posted to a board that publishes full text.

### Scoring change

With descriptions now arriving for most LinkedIn jobs, the `sparse` dual
threshold is **deleted** — `SPARSE_MATCH_THRESHOLD`, `thresholdFor()`, and the
calibration comment justifying them all go. The `sparse` flag survives only as
a marker for jobs enrichment could not reach.

### Reply matching

`send.ts` returns nodemailer's `messageId`, stored on the application/outreach
row. `watch` reads inbound mail and matches when `In-Reply-To` or `References`
contains a stored id. Fallback, only if no id matches: sender address equals
`sentTo`. Exact-first means a forwarded or threaded reply still lands correctly.

### Assisted apply

`/dashboard/queue`, keyboard-driven: `j`/`k` move, `Enter` opens the apply URL
in a new tab, copies the cover letter to the clipboard, and optimistically
marks the item applied. `u` undoes.

## Schema changes

Added to `jobs` / `leads`: `fingerprint`, `sources` (json), `descriptionSource`,
`stage`, `attempts`, `lastError`, `nextAttemptAt`.

Added to `applications` / `outreach`: `messageId`, `followUpCount`,
`nextFollowUpAt`, `respondedAt`.

New indexes: unique `(source, source_id)`; non-unique `fingerprint`; non-unique
`(stage, next_attempt_at)` for the worker's claim query.

Migrations are generated and committed under `lib/infra/db/migrations/`.
Production moves from `db:push` to `db:migrate`.

## Correctness fixes folded in

- `.env.example` is un-gitignored (`!.env.example`) and rewritten for Turso; it
  currently documents `DATABASE_URL` for Postgres, which the code has not used
  since the SQLite migration.
- `app/dashboard/settings/page.tsx` shows a `?secret=` query-param curl that the
  cron route rejects and the README warns against. Replaced with the bearer
  header form.
- All `process.env` reads move behind `lib/config/env.ts`.

## Verification

Vitest. The LinkedIn alert parser is tested first, against saved HTML fixtures —
its own comment calls it "FRAGILE BY NATURE" and it is the most likely thing to
break silently. Also unit-tested: scoring, fingerprint collision and merge,
state transitions, reply matching, enrichment fallback on 429.

GitHub Actions runs lint + typecheck + test + build on push. Nothing enforces
any of these today.

## Explicitly out of scope

- Any headless-browser automation of LinkedIn.
- Any anti-bot detection evasion (fingerprint spoofing, stealth drivers, proxy
  rotation).
- Automated LinkedIn connection requests or InMail.
