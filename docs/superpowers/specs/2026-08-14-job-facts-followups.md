# Phase 1 Follow-ups — Job Facts & Resume-Aware Matching

Date: 2026-08-14
Status: Open items carried out of Phase 1
Spec: `2026-08-14-job-facts-matching-design.md`
Plan: `../plans/2026-08-14-job-facts-matching.md`

Phase 1 shipped and its backfill has been applied to production. These are the
items reviews surfaced that were deliberately NOT fixed, each with the reasoning
and the recommended remedy. They are recorded here rather than in a scratch
directory because several of them are traps for whoever touches this code next.

## Must do before Phase 2 lands

**Stale fingerprints on the 107 repaired LinkedIn rows.** *(Important)*

The Phase 1 backfill repaired `title` and `location` — both inputs to
`fingerprintJob` — but never rewrote the `fingerprint` column. Those rows
therefore carry keys computed from the corrupt pre-repair text:

```
stored:     anon|fullstack developer sourcefuse mohali district on site actively recruiting easy apply|unknown
recomputed: anon|fullstack developer sourcefuse|on site
```

Consequence is confined to CROSS-source merging — the `(source, source_id)`
unique index still prevents same-source duplicates. If one of those 107 jobs
also appears on Adzuna/RemoteOK/Remotive/Himalayas/Jobicy/Arbeitnow/WWR, it will
not merge: two rows, two scores, two cover letters.

Bounded and non-growing — new LinkedIn ingests compute correct fingerprints.

`scripts/reconcile-schema.ts` is NOT a remedy: its fingerprint block only runs
when the `stage` column is added in the same run (a one-time bootstrap already
consumed), and its query is `where fingerprint is null`, which skips rows
holding a stale non-null value.

Remedy: a narrow one-off pass scoped to `source = 'linkedin_alert'` recomputing
`fingerprint` from each row's already-repaired `title`/`location`/`remote`.
`scripts/backfill-facts.ts` is also missing a `fingerprint:` write in its
`.set()` — fix that too, or the next backfill repeats the omission.

**`"Remote (IN)"` is read as `unknown`.** `REGION_LIST_RE` in
`lib/domain/facts/geo.ts` requires TWO OR MORE two-letter codes, so a
single-country parenthetical never matches. Harmless today because no current
source emits it — but Y Combinator uses exactly this format
(`"Remote (GB; DE; NL)"`), so a single-country `"Remote (IN)"` would be
misclassified the moment that source lands. Close it with YC.

## Known limitations, accepted

**Positive fit bonuses vanish at score saturation.** The skill score clamps to
100 before fit adjustments are applied, so for skill-dense postings the
`+10 geo / +5 remote` bonuses have no headroom. Negative adjustments still
separate cleanly, which is the headline goal (US-only remote demotes correctly).
Retuning requires the `FULL_CREDIT_FRACTION` curve, which the comment on it
forbids changing without real outcome data. Phase 3's filters are the proper
answer for arrangement.

**12 LinkedIn rows keep `company: "Unknown"` permanently.** They hold
enrichment-cache entries predating the `company` column, so their cached company
is NULL and `--requeue-enrich` correctly excludes them — requeuing would recover
nothing. Fixing them needs a third mechanism (invalidating those cache rows to
force a re-fetch). Not worth a production operation for 12 rows out of 623;
"Unknown" is honest.

**`geo.ts` matches country tokens anywhere in the `location` string.** An
unenumerated LinkedIn badge or salary tail containing a country or region word
would misclassify eligibility. No current badge does this. The failure direction
is toward `unknown` (neutral), not a confident wrong answer. Watch-item for
whoever next owns that module.

**`"Bengaluru (Canada)"` resolves to `eligible`.** An unambiguous Indian city
short-circuits before the country veto is consulted. Fails toward showing a job
rather than hiding one.

**A polluted title is possible on one parser path.** A new-template LinkedIn
card with no company/location paragraph AND an unenumerated trailing badge
yields e.g. `"Platform Engineer $4M-$5M / year"`. Company still resolves to
`"Unknown"` — nothing is fabricated. Pinned by a test rather than closed,
because closing it needs a trailing-token strip that could truncate a real title
like `"Software Engineer II - $150K Signing Bonus"`.

**Date-fragile tests.** `tests/domain/scoring/score.test.ts:584` starts failing
around Nov 2029 as `yearsOfExperience()` crosses 6; other cases expire 2031 and
2033. They fail loudly as red tests, never as silent wrong behaviour.
`fit.test.ts` shows the immunisation — pass `years` explicitly.

## Deferred

**Upwork — blocked on the operator, not on code.** A mailbox scan found exactly
one message from upwork.com in 60 days, and it was a security notice, not a job
alert. There is nothing to parse.

To unblock: sign in to Upwork, run a job search worth keeping, save it, and turn
on email alerts for that saved search. Once those digests arrive, Upwork becomes
one more `AlertSource` entry in `lib/infra/sources/email/registry.ts` — capture a
fixture with `scripts/capture-alert-fixtures.ts`, write the parser against it,
register it. The dead `ENABLE_UPWORK_RSS` flag and `lib/infra/sources/upwork.ts`
remain untouched until then.

**VirtualVocations** is a second drop-in: 60 alert emails already arriving,
remote-focused. Same three steps.

## Traps for the next person

**`jobs.remote` still carries `.default(true)`.** Removing it made drizzle-kit
emit a non-additive migration (an `ALTER COLUMN` plus DROP/CREATE of all 16
indexes across four tables) against a live table. So the default survives, and
**any insert that omits `remote` silently stores `true`** — the original bug.
Every insert path must pass an explicit value including explicit `null`. See the
comment on the column.

**drizzle's `update().set()` DROPS keys whose value is `undefined`** rather than
writing NULL (`node_modules/drizzle-orm/utils.cjs`, `mapUpdateSet`). Any update
that means "clear this field" must pass explicit `null`, or the stale prior value
survives. This has already caused two near-misses in this codebase.

**`npm run smoke` deletes five tables** and is safe only by accident — it never
loads `.env`, so `getDb()` falls back to `file:./local.db`. Run it from a shell
that has exported `TURSO_DATABASE_URL`, or from CI, and it wipes production.
Every other script routes through `resolveDbTarget()`, which loads `.env` and
prints the resolved target first. `smoke-test.ts` should do the same.
Pre-existing; untouched by Phase 1.

**`tests/fixtures/linkedin-alert.html` is a real captured email** (234KB). It
contains unsubscribe links, the operator's name, and an account-scoped LinkedIn
tracking token. The repo is private; scrub or redact before that changes.

**Six LinkedIn parser fixtures are hand-written, not captured.** They pin an
ASSUMED older template that has never been observed in real mail, and the
parser keeps a fallback path for them. Only `linkedin-alert.html` is real. The
original bug happened precisely because the parser was written against an
assumed template — do not treat those fixtures as evidence of what LinkedIn
sends.

## One constant that is a preference, not a fact

`GEO_ELIGIBLE_BONUS = 10` in `lib/domain/scoring/score.ts` sets whether an
India on-site role outranks a US-only remote role. Current ordering:

```
India remote +15  >  India hybrid/on-site +2  >  nothing known 0  >  US-only remote -20
```

Raising the arrangement penalty or lowering this bonus flips that relationship.
It was chosen because an on-site role in India is physically takeable and a
US-only remote role is not — but the operator's stated preferences were
genuinely ambiguous on the point. One-line edit.

---

# Phase 2 follow-ups (Y Combinator and email-alert sources)

Added 2026-08-14. Spec: `2026-08-14-phase2-sources-design.md`.

## Highest-value follow-up

**A failing parser is indistinguishable from a quiet day.**
`lib/infra/mail/alert-ingest.ts`'s per-message `catch` swallows every parse
exception with no counter and no log. If an email template changes and a parser
starts throwing on every message, that source returns zero jobs and reports
success — identical, from the outside, to "no new alerts today". The whole
`errors` / `notices` / `disabledReason` discipline elsewhere in this pipeline
exists to make exactly that distinction impossible. Count the skipped messages
and surface the count as a notice.

## Known limitations, accepted

**`"Everywhere in the US"` scores as worldwide (+10), not restricted (−25).**
A 35-point swing making an un-takeable job look takeable. Carried because it is
PRE-EXISTING, not introduced by Phase 2: the untouched `anywhere` token already
behaved identically (`"Anywhere in the US"` → worldwide). No captured data
exhibits it. The correct fix bounds BOTH tokens against a trailing
`in <region>`; fixing only `everywhere` would leave the two inconsistent.

**`"Mumbai (GB)"` → `eligible ["in"]`.** An unambiguous Indian city name paired
with an explicit, genuinely foreign country code discards the foreign claim
rather than treating it as an unresolved conflict. This is the deliberate
consequence of the guard that stopped Indian STATE codes (`KA`, `HR`, `UP`)
resolving as foreign countries. No real data pairs a city name with a
contradicting country code — real data uses state codes or leaves the city bare.

**Indeed's `subjectFilter` is deliberately permissive** (`/^apply to jobs\b|@/i`).
A subject like `"You have a new message from recruiter@company.com"` passes it.
That is an accepted trade: the operator's original complaint was jobs NOT
showing up, so dropping a real alert is worse than an occasional stray email
reaching the parser. The safety net is structural rather than aspirational —
`parseIndeedAlert` only creates a card when an anchor carries a `jk=` job key,
so a notification email yields an empty result, a true skip rather than a
fabricated row.

**Wellfound jobs are scored on their title alone.** The digest carries no
description, and enrichment only works on LinkedIn URLs. Salary, arrangement,
location and years are extracted — but none of those feed the skill score.
Expect Wellfound's few-a-week to rank low regardless of quality. Y Combinator
does better here: its `skills[]` land in `tags`, which do enter the scoring
haystack.

**`postedAt` for alert sources** now threads through, but `scoreJob` ignores it.
It is stored for completeness and for any future recency weighting.

## Sources not built, and what unblocks them

**Upwork** — blocked on the operator, not on code. A 60-day mailbox scan found
exactly one message from upwork.com, and it was a security notice. To unblock:
sign in, run a job search worth keeping, save it, enable email alerts on that
saved search. Once digests arrive it becomes one more `AlertSource` entry —
capture a fixture with `scripts/capture-alert-fixtures.ts`, write the parser
against it, register it.

**VirtualVocations** — 60 alert emails already arriving, remote-focused. A
drop-in `AlertSource` whenever it is wanted. Left out only to keep the number of
fragile HTML parsers proportionate to the coverage they add.

## Free data left on the floor

Y Combinator's payload carries `salaryRange`, `companyUrl`, `createdAt` /
`lastActive` and `applyUrl`. Three of those map onto `RawJob` fields that
already exist and are already consumed (`salaryText`, `companyUrl`, `postedAt`).
Cheap wins.

## A trap that survived Phase 2

`lib/infra/sources/email/indeed.ts` reads `title` and `company` positionally as
the first two lines, guarded only against a bare numeric rating. A TEXTUAL badge
before the title — a hypothetical "Sponsored" or "New" label — would silently
store the badge as the title and the real title as the company, cascading every
field after it, with no error and no skip. The file header documents this
honestly. No captured card exhibits it; add a guard if one ever does.
