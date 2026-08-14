# Phase 3 — Dashboard Redesign and Job Filtering

Date: 2026-08-14
Status: Approved, ready for implementation plan
Phase: 3 of 3
Depends on: Phase 1 (`2026-08-14-job-facts-matching-design.md`) and Phase 2
(`2026-08-14-phase2-sources-design.md`), both merged.

## Context

Phases 1 and 2 made the data honest and widened the sources. The operator's
remaining complaint is the interface: "it currently feels like it works but
doesn't", and "important buttons are hidden deep inside settings".

### What was measured

The dashboard holds 695 jobs in a flat list ranked by score, with no filtering,
no search and no way to dismiss anything.

```
status:  found 608 | ready_for_review 66 | matched 19 | applied 2
score:   0-19 383 | 20-39 122 | 40-59 74 | 60-79 54 | 80+ 62
```

**505 of 695 jobs score below the match threshold of 40.** They can never enter
the apply queue, yet they occupy most of the only list the operator can browse.

The facts Phases 1 and 2 derived are stored but invisible: nothing in the UI
shows arrangement, geographic eligibility, years-of-experience or the Easy Apply
flag. They appear only as prose inside `scoreReasons` strings.

```
arrangement x geo:  remote/worldwide 247 | remote/unknown 190 | remote/restricted 104
                    remote/eligible 59 | onsite/eligible 38 | unknown/eligible 38 | hybrid/eligible 13
easy_apply 62 | with salary 50 | with minYears 290
```

Three further findings shaped the design:

**The apply queue is already good.** `components/ApplyQueue.tsx` is
keyboard-driven — `Enter` copies the cover letter, opens the posting and marks
it applied in one keystroke, `u` undoes, updates are optimistic and roll back on
failure. It writes the clipboard *before* opening the tab because opening first
can steal the user gesture and silently leave the letter uncopied. This is the
best interaction in the application.

**The templated look comes from one file.** `app/globals.css` is untouched
Next.js boilerplate — `font-family: Arial, Helvetica, sans-serif` and generic
light/dark variables that the dashboard then overrides with hardcoded
`bg-neutral-950`. There is no design system, only scaffolding.

**Score cannot rank the top of the queue.** The six highest-scoring
`ready_for_review` jobs all score exactly 100 — the saturation issue Phase 1
documented and deliberately left untuned pending outcome data. The interface
must therefore make the *facts* legible, because the *number* does not
discriminate.

## Decisions taken (and why)

**The queue is the product; Jobs is an archive.** Overview and the apply queue
are the daily surfaces. Jobs becomes a searchable, filterable archive visited on
purpose. This bets on the scoring being right, which is what Phases 1 and 2
spent their effort making true.

**Filtering happens on the server, through URL search params.** Three reasons:
695 rows and growing should not be shipped to the browser to be filtered there;
a filtered view becomes a bookmarkable URL; and it finally uses
`jobs_facts_idx`, the index Phase 1 added on `(geo_eligibility, arrangement,
score)` which the Phase 1 final review noted is currently unused.

**Logic lives outside components, so it is tested without a React testing
stack.** This repo has no `@testing-library`, and adding one is its own project.
Instead the filter logic splits into a pure domain module and an infra
query-builder, both unit-testable, leaving components thin enough not to need
tests of their own.

**Dismiss reuses what already exists.** `jobs.status` already accepts
`ignored`, `StatusBadge` already colours it, and `/api/actions/update-status`
already writes it. No new endpoint, no schema change, no migration.

**The apply queue is restyled, not rethought.** Every keystroke is preserved.
Changing an interaction that already works is risk without reward.

It is not a pure restyle in code terms, and the plan must not pretend otherwise:
`QueueItem` in `components/ApplyQueue.tsx` carries no fact fields today, so
showing eligibility and arrangement chips means widening that type and having
`app/dashboard/queue/page.tsx` select and map the extra columns. The
*keyboard handling, clipboard ordering, optimistic updates and undo history stay
untouched* — that is what "restyled, not rethought" protects.

**A system font stack, not a webfont.** `next/font/google` fetches at build
time, which introduces a build-time network dependency for a personal tool. The
typographic gain here comes mostly from the scale, the tracking and tabular
numerals for score alignment — not from the typeface. Swapping in a webfont
later is a one-line change.

**Colour carries meaning, never decoration.** Green means takeable, blue means
no restriction stated, red means not takeable, amber means office presence
required. Everything else is greyscale. This makes the Phase 1 eligibility work
visible at a glance, which was the point of deriving it.

## Architecture

### New and changed files

```
lib/domain/jobs/filters.ts        PURE: JobFilters type, parse/serialize search params
lib/infra/db/job-queries.ts       INFRA: JobFilters -> Drizzle conditions, counts
components/jobs/FilterBar.tsx     client: chips + search box, pushes to the router
components/jobs/JobRow.tsx        dense single-line row
components/ui/Chip.tsx            fact chip with the semantic colour roles
app/globals.css                   REPLACED: design tokens, type scale, colour roles
app/dashboard/layout.tsx          restructured nav; Run pipeline in the header
app/dashboard/page.tsx            Overview restyled; gains Run pipeline
app/dashboard/jobs/page.tsx       dense rows + filter bar + dismiss
app/dashboard/queue/page.tsx      restyled; keystrokes untouched
app/dashboard/resume/page.tsx     NEW: resume upload and history
app/dashboard/freelance/page.tsx  NEW: merges Leads and Outreach
app/dashboard/settings/page.tsx   settings ONLY
```

`app/dashboard/leads/page.tsx` and `outreach/page.tsx` are removed once
`freelance/` subsumes them.

### The filter contract

```ts
// lib/domain/jobs/filters.ts — pure, no I/O
export type JobFilters = {
  eligibility: GeoEligibility[];        // empty = no constraint
  arrangement: WorkArrangement[];       // empty = no constraint
  sources: string[];                    // empty = all
  minScore?: number;
  easyApplyOnly: boolean;
  query?: string;                       // matches title or company
  showDismissed: boolean;               // default false — hides status 'ignored'
  sort: "score" | "newest";             // default "score"
};

export function parseJobFilters(params: URLSearchParams): JobFilters;
export function serializeJobFilters(filters: JobFilters): URLSearchParams;
```

Parsing is total and forgiving: an unknown eligibility value, a non-numeric
score or a malformed sort key is dropped rather than throwing, because these
values arrive from a URL a human can edit. `serializeJobFilters` omits defaults
so a clean view has a clean URL.

`lib/infra/db/job-queries.ts` turns a `JobFilters` into Drizzle conditions and
runs the count. It is the only place that knows about the schema.

### Navigation

```
Overview · Queue · Jobs · Applications · Freelance · Resume · Settings     [Run pipeline]
```

**Run pipeline lives in the header, and only there.** The operator's stated
preference was "on Overview"; the approved mockup placed it in the header. The
header strictly supersedes — it satisfies the same requirement (not buried in
Settings) from every page rather than one. Two buttons firing the same
irreversible-ish action in two places is worse than one in the better place.
Overview keeps the run *context* — the recent-runs table and the dry-run banner
— but not a second button.

Resume becomes a real page rather than a form buried in a configuration list.
Settings returns to holding only settings: the environment table, the drafting
links, and the dry-run banner.

### The dense row

One line per job: score, title, company, then fact chips right-aligned.

```
100  Senior DevOps Engineer · Lemon.io          [eligible] [remote] [4y+]
 86  Senior SDE (Full-stack) · Gushwork         [eligible] [on-site] [easy]
```

Long titles truncate with ellipsis rather than wrapping — the row height stays
constant so the list scans. Score uses tabular numerals so the column aligns.

### The filter bar

A horizontal row of toggle chips above the list: eligibility (4), arrangement
(3), easy-apply, a score threshold, a source selector, a free-text box, and a
`show dismissed` toggle. Above the rows sits a count — `59 of 695 jobs` — which
is the fastest read on whether a filter did what the operator expected.

Each toggle is a link that pushes an updated query string. The bar is a client
component only because it needs `useRouter`; it holds no filter logic of its own.

## Testing

| area | approach |
| --- | --- |
| `filters.ts` | unit: parse/serialize round-trip, unknown values dropped, defaults omitted from the URL |
| `job-queries.ts` | unit against an in-memory libSQL database with the project's real migrations — the pattern Phase 2 established in `tests/pipeline/stages/enrich.test.ts` |
| dismiss | unit: a dismissed job is excluded by default and included when `showDismissed` is set |
| components | none — no React testing stack exists, and components are kept thin enough not to need one |

The existing suite (683 tests) must stay green throughout.

## Out of scope

- Retuning the score curve. The queue's top six all score 100, and this phase
  makes the facts legible rather than the ranking better. `FULL_CREDIT_FRACTION`
  still may not be retuned without real outcome data.
- Any schema change or migration. Dismiss uses the existing `ignored` status.
- Changing the apply queue's interaction model.
- React component tests, and the testing stack they would require.
- Mobile layout. This is a single-operator tool used at a desk; the dense row
  assumes width.

## Risks

**Filtering adds a server round trip per toggle.** Against Turso over HTTP with
`force-dynamic`, expect a few hundred milliseconds. Acceptable for a personal
tool, and the alternative — shipping every row to the browser — degrades as the
table grows. If it proves annoying, the fix is optimistic UI in the filter bar,
not client-side filtering.

**Removing Leads and Outreach changes bookmarked URLs.** Only the operator has
them. Not worth a redirect.

**A dense row hides information.** Truncated titles and three chips cannot show
everything. The chips were chosen for the facts that decide takeability —
eligibility, arrangement, experience, Easy Apply — because those are what the
operator asked for. Salary appears when present; the rest stays on the job page.

**The visual direction is one person's taste.** It is captured as tokens in one
file, so changing the palette or the scale later is a small, contained edit
rather than a sweep through every component.
