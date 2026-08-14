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
