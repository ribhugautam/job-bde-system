# Job Facts — Data Correctness & Resume-Aware Matching

Date: 2026-08-14
Status: Approved, ready for implementation plan
Phase: 1 of 3

## Context

The system ingests ~600 jobs and the operator's verdict is that it "feels like
it works but doesn't". Investigation against the production Turso database
found that judgement to be correct, and located four concrete causes. This
phase fixes the data layer they all share.

### What was measured

```
select count(*), sum(remote=1), sum(remote=0), sum(remote is null) from jobs
-> total 623 | remote=1: 623 | remote=0: 0 | remote is null: 0
```

Every job in the database claims to be remote. Two independent causes:

1. `lib/pipeline/stages/ingest.ts:201` writes `remote: raw.remote ?? true`,
   and the `jobs.remote` column additionally declares `.default(true)`. The
   deliberate tri-state built by `inferRemote()` in
   `lib/infra/linkedin/alerts.ts` is discarded at the moment of writing.
2. Every source fetcher hardcodes `remote: true` — `remoteok`, `remotive`,
   `arbeitnow`, `himalayas`, `jobicy`, `adzuna`. For the remote-only boards
   that is defensible; for `adzuna`, which infers it from a regex hint, it is
   not.

All 107 `linkedin_alert` rows are structurally corrupt:

| stored column | stored value |
| --- | --- |
| `title` | `Full Stack Developer SourceFuse · Mohali district (On-site) Actively recruiting Easy Apply` |
| `company` | `Unknown` |
| `location` | `null` |
| `score` | `0` |

LinkedIn's current alert template wraps an entire job card in a single `<a>`,
so `$(a).text()` at `alerts.ts:226` returns the whole card. The "keep the
longest anchor text per job id" rule at `alerts.ts:232` then cements the
mangled string as the title. Company falls back to `Unknown`, location to
`null`. Cards containing the badge `Actively recruiting` additionally trip the
`recruiting` entry in `ROLE_VETO_PHRASES`, which is a fatal veto — score 0,
status `rejected`, never reaching the apply queue.

The operator's report that "LinkedIn Easy Apply jobs are not showing up" is
therefore a symptom of total LinkedIn breakage, not of Easy Apply specifically.

Upwork is dead, not misconfigured:

```
410 Gone   https://www.upwork.com/ab/feed/jobs/rss?q=react+developer&sort=recency
403        https://www.upwork.com/nx/search/jobs/?q=react
```

There is no experience or geographic-eligibility model. Years of experience
exists only as a boolean penalty at >= 8 years, buried inside `score.ts`.
Location is an unnormalized string.

## The core insight

`remote` is the wrong question, and answering it better would not have helped.

| location | rows | remote? | hireable from India? |
| --- | --- | --- | --- |
| `Worldwide` / `Anywhere in the World` | 234 | yes | **yes** |
| `USA` | 37 | yes | **no** |
| `Europe` / `LATAM` | 30 | yes | **no** |
| Bengaluru / Pune / Gurgaon (On-site) | LinkedIn | **no** | yes |

"Remote, USA" and "Remote, Worldwide" are both `remote: true` and are currently
indistinguishable. That single conflation is the main reason the ranked list
does not reflect what the operator can actually take. The fix is to stop
modelling one axis and start modelling two: **work arrangement** and
**geographic eligibility** are independent, and only the second one answers
"can I actually take this job".

## Decisions taken (and why)

**Extraction is deterministic, not LLM-based.** The phrasings that matter are
narrow (`(Hybrid)`, `5+ years`, `Remote (US only)`), the codebase's established
character is honest tri-states over confident guesses, and the incoming Y
Combinator source (Phase 2) supplies `minExperience` and `visa` as structured
fields for free. `ANTHROPIC_API_KEY` is currently unset. The extractor is
designed as a pure module with a single entry point so an LLM fallback can be
added later without reshaping anything around it.

**`unknown` is a first-class value.** Consistent with the existing
`inferRemote()` tri-state: a fact the posting does not state is recorded as
unknown, scored as neither bonus nor penalty. Nothing is inferred by default.

**Non-remote roles are penalized but never hidden.** The operator selected
remote-worldwide, remote-US/EU and freelance as matches, but also asked
specifically for LinkedIn Easy Apply roles — which are almost entirely on-site
and hybrid in India — to become visible. Those two statements are reconciled by
ranking remote first while keeping every arrangement correctly classified and
reachable through a filter. Only the pre-existing role veto stays fatal.

**Fit adjustments are applied after normalization, in real points.** The
comment at `score.ts:64` warns that raw-point penalties are amplified roughly
2.9x by the normalization divisor, and that retuning the curve needs real
outcome data rather than a guess. That warning is respected: the skill/role
core is untouched, and the new dimensions are bounded adjustments applied to
the already-normalized 0-100 score, where their magnitude is legible.

**The schema change is additive only.** SQLite cannot alter a column, and
drizzle-kit's 12-step table rebuild against a live Turso database is risk with
no compensating benefit. The `remote` column is kept and written honestly, but
is read by nothing; `arrangement` becomes the source of truth. Every migration
statement is `ALTER TABLE ... ADD COLUMN`, which is instant and safe.

**The 107 corrupt LinkedIn rows are repaired, not re-fetched.** The mangled
`title` column happens to contain the entire card text, so the same parser that
handles fresh emails can recover title, company, location and arrangement from
what is already stored. Backfill therefore needs no mailbox access.

## Architecture

### New: `lib/domain/facts/`

Pure functions, zero I/O, unit-testable with plain data. Follows the existing
one-way rule that `domain/` never imports `infra/`.

```
lib/domain/facts/
  types.ts         WorkArrangement, GeoEligibility, JobFacts
  arrangement.ts   location + description + tags -> WorkArrangement
  geo.ts           -> { regions, eligibility }
  experience.ts    -> { minYears, maxYears, experienceText }
  index.ts         deriveJobFacts(raw) + FACTS_VERSION
```

```ts
export type WorkArrangement = "remote" | "hybrid" | "onsite" | "unknown";

export type GeoEligibility =
  | "worldwide"   // no restriction stated
  | "eligible"    // explicitly includes India/APAC, or the role is IN India
  | "restricted"  // explicitly excludes the operator - "US only", "EU residents"
  | "unknown";

export type JobFacts = {
  arrangement: WorkArrangement;
  geoEligibility: GeoEligibility;
  geoRegions: string[];      // normalized: ["us"], ["worldwide"], ["in","apac"]
  minYears?: number;         // undefined when not stated - never guessed
  maxYears?: number;
  experienceText?: string;   // the matched phrase, for display in the UI
  easyApply?: boolean;
};
```

`arrangement.ts` absorbs the existing `inferRemote()` from
`lib/infra/linkedin/alerts.ts`, widening its two-state-plus-undefined result to
the four-state enum. `experience.ts` absorbs `YEARS_REQUIREMENT_PATTERNS` from
`score.ts:93` — those regexes are already written and correct, but their result
is currently collapsed to a boolean and thrown away.

Derivation runs at ingest so that SQL can filter and sort on the results, but
lives in a pure module so the backfill re-runs it identically. That split is
the seam an LLM fallback would later occupy.

### Schema additions

```sql
ALTER TABLE jobs ADD COLUMN arrangement     text;
ALTER TABLE jobs ADD COLUMN geo_eligibility text;
ALTER TABLE jobs ADD COLUMN geo_regions     text;    -- json array
ALTER TABLE jobs ADD COLUMN min_years       integer;
ALTER TABLE jobs ADD COLUMN max_years       integer;
ALTER TABLE jobs ADD COLUMN experience_text text;
ALTER TABLE jobs ADD COLUMN easy_apply      integer; -- boolean 0/1
ALTER TABLE jobs ADD COLUMN facts_version   integer NOT NULL DEFAULT 0;

CREATE INDEX jobs_facts_idx ON jobs (geo_eligibility, arrangement, score);
CREATE INDEX jobs_facts_version_idx ON jobs (facts_version);
```

`facts_version` exists so that improving the extractor is routine rather than a
one-shot event: bump the constant, run the backfill, and only stale rows are
re-derived. `jobs_facts_version_idx` keeps that scan cheap as the table grows.

`RawJob` in `lib/domain/types.ts` gains the same optional fields, so a source
that already knows a fact (Y Combinator's `minExperience`, Himalayas'
`locationRestrictions`) can supply it directly instead of having it re-derived
from prose. Derivation fills only what the source left undefined.

### Ingest changes

`lib/pipeline/stages/ingest.ts` calls `deriveJobFacts()` and persists the
result. The `remote ?? true` coercion at line 201 is replaced by an honest
write derived from `arrangement`:

```ts
remote: facts.arrangement === "unknown" ? null : facts.arrangement === "remote",
```

`jobs.remote` is marked deprecated in `schema.ts` and read by nothing after
this phase. It is left in place for one phase so the change stays additive; a
later cleanup can drop it.

`adzuna.ts` stops asserting `remote: true` from a regex hint and leaves the
value undefined, letting the extractor classify it honestly.

### Scoring changes

`scoreJob()` keeps its skill matching, target-role bonus and fatal role veto
exactly as they are. The crude `remote` bonus and the `>= 8 years` penalty are
removed from the raw accumulator and replaced by post-normalization adjustments:

```
final = clamp(0, 100, skillScore + geoAdj + experienceAdj + arrangementAdj)
```

| dimension | condition | adjustment |
| --- | --- | --- |
| geo | `restricted` | -25 |
| geo | `worldwide` or `eligible` | +8 |
| geo | `unknown` | 0 |
| experience | `minYears` > operator's years + 2 | -20 |
| experience | `minYears <= operator's years <= maxYears` | +6 |
| experience | not stated (`minYears` undefined) | 0 |

When only `minYears` is stated and it falls within tolerance, the row earns
neither adjustment: the posting has set a floor the operator clears, which is
not evidence of a good fit in either direction.
| arrangement | `remote` | +5 |
| arrangement | `hybrid` or `onsite` | -8 |
| arrangement | `unknown` | 0 |

Every adjustment appends a human-readable entry to `scoreReasons`, matching the
existing convention that the dashboard can explain any number it shows.

The operator's years of experience is currently hardcoded as prose in
`resume-profile.ts:26` ("nearly 3 years") and will silently rot. A
`CAREER_START` constant is added and the figure computed from it.

### LinkedIn parser rewrite

`parseAlertEmail()` is rewritten for the single-anchor card template:

1. Strip known badge suffixes from the tail of the card text. `Easy Apply`,
   `Actively recruiting`, `Promoted`, `Applied on <date>`, `N school alum` and
   the rest are already enumerated in `BADGE_LINE_PATTERNS`; that list is
   reused and extended rather than rewritten.
2. Detect `Easy Apply` while stripping it, and record it as `easyApply: true`.
3. Split on the `·` separator. The right-hand side is the location, with the
   work arrangement in a trailing `(...)` suffix.
4. Resolve the company from the card's company anchor (`linkedin.com/company/`)
   or the logo `<img alt>`, rather than positionally. Fall back to `Unknown`
   only when neither is present.

```
"Full Stack Developer SourceFuse · Mohali district (On-site) Actively recruiting Easy Apply"
  -> title       "Full Stack Developer"
     company     "SourceFuse"
     location    "Mohali district"
     arrangement onsite
     easyApply   true
```

A second exported function, `repairMangledCard(title)`, applies steps 1-3 to a
stored title string, so the 107 existing rows can be recovered by the backfill
without mailbox access.

**What repair can and cannot recover.** Step 4 resolves the company from HTML
the stored string does not contain, so repair cannot split `"SDE II HSV
Digital"` into title `SDE II` and company `HSV Digital` — no rule can, without
a company list. Repair therefore recovers location, arrangement, `easyApply`
and a badge-stripped title, and leaves `company` as `Unknown`. That is enough
to fix the scores, because the fatal `Actively recruiting` veto and the wrong
arrangement both live in the parts repair *can* clean. The residual `Unknown`
company is closed separately by extending the enrichment fetch to read
`hiringOrganization.name` from the public page's JSON-LD, which
`parseJobPage()` already parses for the description.

**Dependency: a real email fixture.** The template above is inferred from
corrupt database rows, not from HTML. Writing the parser against an inferred
shape would repeat the original mistake. The first implementation task is a
read-only script that fetches one LinkedIn alert email over IMAP (credentials
already present in `.env`; the existing connector opens the mailbox with
`readOnly: true`) and saves its HTML as a test fixture. The parser is then
written test-first against that fixture. Operator confirmation is required
before the script touches the mailbox.

### Backfill

`scripts/backfill-facts.ts`:

1. Repairs `linkedin_alert` rows via `repairMangledCard()`.
2. Re-derives facts for every row where `facts_version < FACTS_VERSION`.
3. Re-scores affected rows, resetting `status`/`stage` so that rows previously
   marked `rejected` on a corrupt score re-enter the pipeline.
4. Prints a before/after distribution of arrangement and geo eligibility.

Idempotent and resumable, in keeping with the existing worker. Step 4 is the
verification that matters: `623/623 remote` becoming a believable spread is the
observable proof this phase worked.

## Testing

| area | approach |
| --- | --- |
| `facts/arrangement.ts` | unit, table-driven over real location strings from the database |
| `facts/geo.ts` | unit, including `Remote (GB; DE; NL)` and `Gurgaon, Haryana, India` |
| `facts/experience.ts` | unit, reusing the existing cases in `tests/domain/scoring/score.test.ts` |
| LinkedIn card parser | fixture test against the captured email HTML |
| `repairMangledCard` | unit, using the real corrupt strings from production |
| scoring | asserts a US-only remote role ranks below an India-eligible one |
| regression | existing `score.test.ts` cases still pass; the role veto stays fatal |

The existing suite (`tests/domain/scoring/score.test.ts`, 1096 lines) is the
guard against regressing the skill matcher, and must stay green throughout.

## Out of scope for this phase

- Y Combinator, Upwork and Wellfound connectors (Phase 2)
- Generalizing the IMAP reader into a shared email-alert ingest (Phase 2)
- UI redesign, navigation restructure and filter controls (Phase 3)
- Retuning the skill-score normalization curve — needs outcome data, per the
  standing warning at `score.ts:64`
- Dropping the deprecated `jobs.remote` column
- The `leads` table, which has no geographic dimension worth modelling yet

## Risks

**The email fixture may reveal a different template.** Mitigated by capturing
it before writing the parser rather than after. If the real template differs
from the inference, the design of steps 1-4 changes but nothing else in this
phase does.

**Repair cannot recover what was never stored.** A LinkedIn row whose card text
lacks a `·` separator will fall back to `Unknown`/`unknown` rather than a wrong
value, matching the file's existing philosophy. The backfill reports how many
rows it could not fully repair.

**Adjustment magnitudes are estimates.** They are calibrated by judgement, not
outcome data. They are deliberately bounded and applied post-normalization so
that changing them later is a legible one-line edit rather than a re-derivation
of the curve.

**`ENABLE_LINKEDIN_ALERTS=0` locally, `1` in production.** Local runs will not
exercise the connector. Noted rather than changed; the fixture test covers the
parser without needing the flag.
