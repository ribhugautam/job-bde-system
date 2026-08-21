# Multi-user accounts, resume-ranked inbox, and source retirement

Date: 2026-08-21
Status: approved (design), pending implementation

## Problem

Three things, in ascending order of size.

1. `upwork_rss` fails every run with **HTTP 410 Gone**. Verified independently:
   `curl` against the feed URL returns 410. Upwork retired its public RSS job
   feeds; 410 means *permanently* gone, so there is nothing to repair and
   retrying daily is wrong by protocol. It currently reports under **PROBLEMS**
   in every digest, which trains the reader to ignore that section.

2. Colleagues want to use the system. Today there is no user table and no
   signup: one `APP_PASSWORD` unlocks everything (`lib/infra/auth.ts`), there is
   exactly one active resume row, one Gmail sending identity, and one global
   `score` column computed against a resume profile that is **hardcoded as a
   TypeScript module** (`lib/domain/scoring/resume-profile.ts`, containing one
   person's name, phone, skills and target roles).

3. Old and new jobs are not meaningfully separated. There is no seen/unseen
   concept at all. `lib/domain/jobs/filters.ts` offers a `newest first` sort and
   a `show dismissed` toggle; nothing else. Jobs accumulate forever - roughly
   695 rows today, growing ~72/day - and a posting from six weeks ago (almost
   certainly filled) renders identically to one from this morning.

## Decisions

Settled during brainstorming with the operator:

| Question | Decision |
|---|---|
| Data model | **Shared job pool, private per-user state** |
| Job list UI | **No filter controls.** Ranked by the viewer's own resume |
| Profile source | **Auto-extract from the uploaded PDF, then editable** |
| Old vs new | **Inbox / Working / Archive, with auto-expiry** |
| Accounts | **Invite-only; the operator is admin** |
| Sending | **Each person's own mailbox; auto-send off until configured** |

Assumptions taken by the implementer where the operator did not express a
preference. All three are cheap to reverse:

- **A text search box is kept** on the job list. Finding a specific company is
  navigation, not filtering.
- **`JOB_STALE_DAYS` defaults to 30**, and is an env var so it can be retuned
  without a deploy.
- **Colleagues get the full path** - their own resume, drafting and sending -
  rather than a browse-only tier.

## Non-goals

- Replacing the freelance lead coverage lost with Upwork. Two lead sources
  remain (`arbeitnow_contract`, `wwr_contract`). Adding a replacement is
  separate work.
- Any LLM in the scoring or extraction path. The system is LLM-free today and
  stays that way; extraction is heuristic.
- Per-user job *ingestion*. One pipeline run feeds everybody, which is the
  entire point of the shared pool.

## Design

### 1. Source retirement

`SourceDefinition` gains an optional `retired` field:

```ts
retired?: { since: string; reason: string }
```

A retired source never fetches, and its enablement flag is ignored entirely -
so `ENABLE_UPWORK_RSS=1` cannot resurrect a dead endpoint. It is reported under
**For information** as "retired upstream", never under PROBLEMS.

The `upwork_rss` registry entry stays as a tombstone because `name` is a
persisted value forming half the `(source, source_id)` dedupe key; removing it
would orphan every lead already stored under it. The fetcher module is deleted
as dead code.

### 2. Accounts

New tables:

- `users` - email (unique), name, `passwordHash`, `passwordSalt`, `role`
  (`admin` | `member`), `isActive`, `lastSeenAt`
- `invites` - single-use token, email, role, `expiresAt`, `acceptedAt`

**Password hashing is PBKDF2-SHA256 via Web Crypto**, not bcrypt. The codebase
holds a deliberate "Web Crypto only" line so `lib/infra/auth.ts` can run on the
Edge runtime in `proxy.ts`; a native dependency would break that for no gain.

**Sessions stay stateless.** The token format goes from `exp.hmac(exp)` to
`userId.exp.hmac(userId.exp)`. No session table, and `proxy.ts` keeps verifying
signatures without a database round trip on the Edge.

Because the Edge gate cannot check the database, a deactivated user's cookie
stays *cryptographically* valid until it expires. The application layer is
therefore the authority on identity: `getSessionUser()` loads the row and
rejects `isActive = false`. Every page and API route uses it. The Edge gate
proves *a* valid session exists; only the app layer proves *which* live user.

**Lockout is prevented explicitly.** The migration mints an admin account from
the existing `OWNER_EMAIL` + `APP_PASSWORD`, so the operator can still log in
the moment it runs. `APP_PASSWORD` becomes legacy-only. Existing applications,
outreach and the resume row are assigned to that admin user.

### 3. Per-user profile

`lib/domain/scoring/resume-profile.ts` currently conflates two things. It is
split:

- **A shared skill taxonomy** - vocabulary, aliases, default weights. Reusable
  by everyone; it is the extractor's dictionary.
- **`user_profiles`** - one row per user: their skill subset with weights,
  target roles, veto phrases, career start, contact block for signatures, and
  arrangement/geo preferences.

Extraction on resume upload: pull text with `unpdf` (serverless-safe), match
against the taxonomy, read dates for career start, read title lines for target
roles. Heuristic and imperfect - which is why the result is shown on an
editable profile page rather than hidden.

**Arrangement and geo preferences move into the profile.** Today "I don't want
on-site" is a filter chip; with no filter bar it needs a home, and the profile
is the honest one. This is what makes "no filters, ranked by resume" a real
ranking change rather than just hidden controls.

`scoreJob()` is refactored to take a profile argument instead of importing
module constants. Compiled regex matchers are cached per profile, keyed on
`userId` + `updatedAt`, so the per-request cost stays at today's level.

### 4. Ranked feed, and derived buckets

Scores are **computed at read time** against the viewing user's profile, not
materialized per user per job. `scoreJob()` is pure and microsecond-cheap, so
this avoids a rescore job on every profile edit, an entire staleness class of
bug, and a user x job backfill. Documented threshold: revisit if the active job
set passes roughly 20,000 rows, at which point ordering must move into SQL.

Buckets are **derived, not stored**:

| Bucket | Rule |
|---|---|
| **Inbox** | No state row for this user, and `postedAt ?? fetchedAt` is newer than `JOB_STALE_DAYS` |
| **Working** | State row with status matched / applied / sent / responded / interview / offer |
| **Archive** | Dismissed by this user, or aged out of Inbox untouched |

The consequence is the point of the design: **a row is written only when a user
acts on a job.** A new colleague logs in to a fully ranked inbox with zero rows
written for them - no backfill, no user x job explosion - and auto-expiry costs
nothing because staleness is a date comparison rather than a sweep job.
Changing `JOB_STALE_DAYS` reflows every bucket instantly and reversibly.

"New since I last looked" is a `users.lastSeenAt` column and a badge, not a
seen/unseen state machine.

Deleted by this change: `components/jobs/FilterBar.tsx`, most of
`lib/domain/jobs/filters.ts`, the filter conditions in
`lib/infra/db/job-queries.ts`, and `tests/domain/jobs/filters.test.ts`.

### 5. Per-user sending

`user_mail` holds each person's SMTP identity. The password is **encrypted at
rest** with a key derived from a new `ENCRYPTION_KEY` env var - deliberately
not `AUTH_SECRET`, because rotating a signing key must not destroy stored
credentials.

`lib/infra/mail/send.ts` takes a sender identity as an argument instead of
reading `GMAIL_USER` globally. `applications` and `outreach` gain a `userId`.

**Auto-send is off per user until they have configured and verified a mailbox**;
their drafts queue for one-click sending instead. Nothing can go out under the
wrong name, which is the failure mode most worth avoiding here.

## Testing

Pure domain logic carries the coverage, matching the existing suite's shape:

- password hash/verify round trip; wrong password rejected
- session token carrying `userId`; tampered and expired tokens rejected
- invite lifecycle: single use, expiry, already-accepted
- profile extraction against committed resume-text fixtures
- per-user scoring: two profiles rank the same job differently
- bucket derivation, including the exact staleness boundary
- retired sources never fetch and never appear in PROBLEMS
- credential encryption round trip

## Delivery order

Each phase lands independently with `npm run verify` green.

1. **Upwork retirement** - independent; stops the daily error immediately
2. **Accounts** - users, invites, per-user sessions, admin screens
3. **Profile + extraction** - taxonomy split, PDF parsing, profile page
4. **Inbox + ranked feed** - the UI redesign, filter removal
5. **Per-user sending** - mail identity, drafting, dispatch ownership

## Risks

- **Phase 5 is the largest** and touches the live send path. `DRY_RUN` remains
  the master switch throughout.
- **Extraction quality is variable.** Mitigated by the profile being editable
  and by showing the user what was extracted.
- **Storing colleagues' SMTP credentials** is new sensitive data. Encrypted at
  rest; never logged; never returned to the client after saving.
- **The Edge/app split on identity** is subtle and is the most likely place for
  a future authorization bug. Stated explicitly in section 2 and enforced by
  `getSessionUser()` being the only way to read identity.
