# Phase 2 — Y Combinator and Email-Alert Job Sources

Date: 2026-08-14
Status: Approved, ready for implementation plan
Phase: 2 of 3
Depends on: `2026-08-14-job-facts-matching-design.md` (Phase 1, merged)

## Context

Phase 1 made the system honest about the jobs it already had. Phase 2 widens
what it can see.

The operator asked for Upwork, Y Combinator and Wellfound. Investigation
changed two of those three answers, so this spec is built on what is actually
reachable rather than on what was assumed.

### What was measured

Upwork's RSS search feed is retired:

```
410 Gone   https://www.upwork.com/ab/feed/jobs/rss?q=react+developer&sort=recency
403        https://www.upwork.com/nx/search/jobs/?q=react
```

A read-only scan of the operator's mailbox (envelopes only, 60 days, 1832
messages) established which email-alert sources genuinely exist:

| sender | messages | representative subject | verdict |
| --- | --- | --- | --- |
| linkedin.com | 311 | `Agentic AI Engineer at Walnutt` | already ingested |
| indeed.com | 78 | `Apply to jobs at Wits Innovation Lab, snabs solution and Yaarify` | real alerts |
| virtualvocations.com | 60 | `New Job Opening for Senior Full Stack Developer` | real alerts |
| wellfound.com | 11 | `New jobs: Full Stack Engineer at Seamless.finance and 3 more jobs` | real alerts |
| upwork.com | 1 | `An unknown device or browser has been used to access your account` | **security notice, not a job alert** |

So Upwork cannot be built: there is nothing to parse. Two sources nobody
planned for — Indeed and VirtualVocations — are sitting unused with 138
messages between them.

Y Combinator serves a public, unauthenticated Inertia payload:

```
GET https://www.ycombinator.com/jobs/role/eng   -> 200, 35 jobPostings
minExperience: "3+ years" | "6+ years" | "Any (new grads ok)"
visa:          "US citizenship/visa not required" | "US citizen/visa only" | "Will sponsor"
```

## Scope

**In:** Y Combinator (engineering role), a shared email-alert ingest, and
Wellfound and Indeed parsers built on it.

**Out:** Upwork (blocked on the operator enabling alerts — see Deferred);
VirtualVocations (a documented drop-in once the framework exists); the UI,
which is Phase 3.

## Decisions taken (and why)

**Each email source keeps its own IMAP connection.** `client.fetch({ since,
from })` resolves server-side via IMAP `SEARCH`, so a per-source search pulls
only that sender's mail rather than dragging all 1832 messages through the
pipeline. Getting to a single shared connection would require memoizing the
fetch across sources, because `lib/infra/sources/index.ts` runs them through
`Promise.all`. That memo would live at module scope, and Vercel reuses lambda
instances, so it would outlive the run and serve stale jobs on the next one.
Three connections once a day, against a Gmail limit of roughly fifteen, is the
cheaper trade than cross-run cache state.

**LinkedIn's parser does not move.** It took three fix rounds to stabilise, and
churning it would risk that for no gain. The registry references it where it
lives.

It does not, however, match the contract exactly: `parseAlertEmail` returns
`Parsed[]`, which carries no `url` — `fetchLinkedInAlerts` builds the canonical
URL from the job id separately. Rather than widen `parseAlertEmail`, the
registry entry adapts it inline:

```ts
parse: (html) =>
  parseAlertEmail(html).map((p) => ({
    ...p,
    url: `https://www.linkedin.com/jobs/view/${p.id}/`,
  })),
```

One line in the registry, no edit to `alerts.ts`.

What does change there: `fetchLinkedInAlerts` drops its hand-rolled `ImapFlow`
client and adopts the existing `withMailbox()` helper in
`lib/infra/mail/imap.ts` — that helper already exists and is what "generalise
the IMAP reader" actually amounts to.

**Y Combinator stays outside the email framework.** It is an HTTP fetch of a
JSON payload embedded in an HTML attribute. Forcing it and the email sources
under one abstraction would earn nothing and obscure both.

**Fixtures are captured before parsers are written.** Phase 1's highest-value
task was capturing one real LinkedIn alert email; it immediately disproved a
structural assumption that would otherwise have shipped. The same rule binds
here: no email parser is written before a real message of that shape is saved
as a fixture.

**Source names are permanent.** `ycombinator`, `wellfound_alert` and
`indeed_alert` join the persisted `source` column and form half the
`(source, source_id)` dedupe key. They can be added but never renamed.

## Architecture

```
lib/infra/mail/alert-ingest.ts        shared runner: withMailbox + per-source SEARCH + parse
lib/infra/sources/email/registry.ts   [{ name, fromDomain, days, subjectFilter?, parse }]
lib/infra/sources/email/wellfound.ts  parse(html) -> ParsedAlertJob[]
lib/infra/sources/email/indeed.ts     parse(html) -> ParsedAlertJob[]
lib/infra/sources/ycombinator.ts      HTTP + Inertia payload -> RawJob[]
```

### The email-alert contract

```ts
export type ParsedAlertJob = {
  /** Stable per-source id; becomes source_id. */
  id: string;
  title: string;
  company: string;
  location?: string;
  url: string;
  arrangement?: WorkArrangement;
  easyApply?: boolean;
};

export type AlertSource = {
  /** Persisted source name — never rename. */
  name: string;
  /** Sender domain, passed to the server-side IMAP SEARCH. */
  fromDomain: string;
  /** Lookback window in days. */
  days: number;
  /** Optional: reject non-job mail from the same sender before parsing. */
  subjectFilter?: (subject: string) => boolean;
  parse: (html: string) => ParsedAlertJob[];
};
```

`subjectFilter` exists for a measured reason: Wellfound sends two shapes from
one address — `"New jobs: …"` and `"An update from Univaens, ParallelDots and 37
others"`. The second is company-activity digest, not job listings, and parsing
it would manufacture garbage rows. Putting the filter in the registry keeps each
parser from reinventing that check.

`alert-ingest.ts` exports one function, `fetchAlertSource(source: AlertSource):
Promise<RawJob[]>`. It is shared code called once per source, not a batch runner
over all of them — each call opens the mailbox read-only via `withMailbox()`,
issues the sender-and-date-filtered search, applies `subjectFilter`, parses each
message, de-duplicates by `id` within the run, and maps to `RawJob`. It never
throws past its own boundary: a parse failure on one message skips that message
rather than losing the rest.

Each registry entry in `JOB_SOURCES` therefore becomes a thin wrapper —
`fetch: () => fetchAlertSource(WELLFOUND)` — which preserves per-source
enablement, naming and `disabledReason` reporting exactly as they work today.

### Y Combinator mapping

```
jobPostings[].title          -> title
             .companyName    -> company
             .url            -> https://www.ycombinator.com + url
             .location       -> location (feeds arrangement + geo derivation)
             .minExperience  -> minYears, via deriveExperience (no new parser)
             .visa           -> geoEligibility
             .skills[]       -> tags
             .id             -> sourceId
```

`visa` is the strongest geographic signal in the system, because it is *stated*
rather than inferred from location prose:

| visa value | geoEligibility |
| --- | --- |
| `US citizen/visa only` | `restricted`, regions `["us"]` |
| `US citizenship/visa not required` | leave undefined; fall through to location derivation |
| `Will sponsor` | leave undefined; fall through to location derivation |

Only the first is a restriction. The other two say the employer will not block
on visa status, which is not the same as stating where they hire — so they must
not be read as `eligible`, or the system would assert something the posting
never said.

`applyEmail` is always undefined: YC applications go through their own account
flow, so these can never auto-send and will land in the manual apply queue.

### A Phase 1 debt this settles

`REGION_LIST_RE` in `lib/domain/facts/geo.ts` requires **two or more**
two-letter country codes, so a single-country parenthetical never matches and
`"Remote (IN)"` resolves to `unknown`. Y Combinator emits exactly that format,
so the gap stops being theoretical. Phase 2 widens the pattern to accept a
single code, with regression cover for the existing multi-code cases.

## Testing

| area | approach |
| --- | --- |
| capture | read-only script saves one real Wellfound and one real Indeed email as fixtures, and one YC payload |
| wellfound parser | fixture test; plus a case asserting an `"An update from…"` digest yields zero jobs |
| indeed parser | fixture test over the multi-job digest shape |
| ycombinator | fixture test over the saved payload, including all three `visa` values |
| geo | regression: `"Remote (IN)"` becomes `eligible`; `"Remote (GB; DE; NL)"` stays `restricted` |
| registry | the existing `tests/infra/sources/registry.test.ts` guards enablement and naming |

Every source runs through the existing `safeFetchSource`, so one broken parser
cannot take down a run, and a switched-off source is reported as off rather than
silently producing nothing.

## Risks

**Email templates change without notice.** This is what broke LinkedIn. Each
parser degrades to skipping a message rather than producing a confident wrong
value, and fixtures pin the shape that was actually observed.

**Indeed's volume skews Indian consultancies.** 78 messages of largely agency
postings. The role veto and geo scoring will do real work; expect a lower match
rate than the remote boards and watch the first run's queue volume.

**Wellfound's two subject shapes.** Mitigated by `subjectFilter`, which is a
registry-level guard and testable without a mailbox.

**YC pagination is unverified.** The endpoint returns 35 postings for `eng`;
whether that is the full set or a first page has not been established. The
connector takes what the payload gives and does not attempt pagination.

## Deferred

**Upwork.** Blocked on the operator, not on code. To unblock: sign in to
Upwork, run a job search worth saving, save it, and enable email alerts on that
saved search. Once those emails arrive, Upwork becomes another `AlertSource`
entry. The dead `ENABLE_UPWORK_RSS` flag and `lib/infra/sources/upwork.ts` stay
untouched this phase.

**VirtualVocations.** 60 alert emails available; a drop-in `AlertSource` once
the framework exists. Left out to keep the number of fragile HTML parsers
proportionate to the coverage they add — its remote listings likely overlap the
boards already ingested.
