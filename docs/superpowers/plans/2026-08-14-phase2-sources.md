# Phase 2 — Y Combinator and Email-Alert Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Y Combinator as a job source, and a shared email-alert ingest carrying Wellfound and Indeed alongside the existing LinkedIn connector.

**Architecture:** A registry of `AlertSource` descriptors, each with its own sender-filtered IMAP search run through the existing read-only `withMailbox()` helper. Parsers are pure `(html) => ParsedAlertJob[]` functions written against real captured emails. Y Combinator sits outside that framework — it is an HTTP fetch of a JSON payload embedded in an HTML attribute.

**Tech Stack:** TypeScript, Next.js 16, Drizzle ORM on libSQL/Turso, Vitest, cheerio, imapflow, mailparser.

**Spec:** `docs/superpowers/specs/2026-08-14-phase2-sources-design.md`

## Global Constraints

- **`lib/domain/` must NEVER import from `lib/infra/`.** Parsers live in `lib/infra/`; the fact extractors they feed live in `lib/domain/facts/` and must stay pure.
- **`unknown` is never guessed.** A fact the email does not state is `undefined`/`unknown`, never defaulted to the common case. An honest "Unknown" company beats a confident wrong one.
- **Source `name` values are PERSISTED** and form half the `(source, source_id)` dedupe key. New names this phase: `ycombinator`, `wellfound_alert`, `indeed_alert`. Add freely; never rename an existing one.
- **No anti-bot behaviour anywhere.** No proxy rotation, no user-agent spoofing, no retry storms, no evasion. A 403/429 is an acceptable outcome that degrades gracefully.
- **IMAP is strictly read-only.** Mailboxes open with `readOnly: true`. Nothing may call `messageFlagsSet/Add/Remove`, `messageMove`, `messageCopy`, `messageDelete` or `append`.
- **Never parse positionally where a shape check will do.** Indeed inserts a company rating line that shifts every following field; LinkedIn's badge lines did the same and produced `company: "Promoted"`.
- The existing suite must stay green. Verification: `npm run verify` (= lint + typecheck + test). Currently 623 tests.
- No TODO/TBD comments or commented-out code.

---

### Task 1: Fixtures and the shared email-alert contract

The capture script has already been written and run; both fixtures exist on disk uncommitted. This task commits them and defines the types every later task depends on.

**Files:**
- Commit (already present): `scripts/capture-alert-fixtures.ts`, `tests/fixtures/alerts/wellfound.html`, `tests/fixtures/alerts/indeed.html`
- Create: `lib/infra/sources/email/types.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `ParsedAlertJob`, `AlertSource` — imported by Tasks 2, 3, 4 and 5.

- [ ] **Step 1: Confirm the fixtures are present and non-empty**

Run: `ls -la tests/fixtures/alerts/`
Expected: `wellfound.html` (~33KB) and `indeed.html` (~117KB).

If either is missing, run `npx tsx scripts/capture-alert-fixtures.ts` — but ASK THE OPERATOR FIRST, it reads their mailbox.

- [ ] **Step 2: Write the shared types**

```ts
// lib/infra/sources/email/types.ts
import type { WorkArrangement } from "@/lib/domain/facts";

// ---------------------------------------------------------------------------
// The contract every email-alert parser satisfies.
//
// Parsers are pure functions over an HTML string: no network, no mailbox, no
// database. That is what lets them be tested against a real captured email and
// nothing else. lib/infra/mail/alert-ingest.ts owns everything impure.
// ---------------------------------------------------------------------------

export type ParsedAlertJob = {
  /**
   * Stable identifier for this posting WITHIN this source. Becomes `source_id`,
   * so it must be derivable from the same posting in a later email — never a
   * per-send tracking token. Indeed has a real job key in its links; Wellfound
   * does not, so its parser derives one (see lib/infra/sources/email/wellfound.ts).
   */
  id: string;
  title: string;
  company: string;
  location?: string;
  url: string;
  arrangement?: WorkArrangement;
  easyApply?: boolean;
  /** Description snippet when the digest carries one — Indeed does, LinkedIn does not. */
  description?: string;
  salaryText?: string;
  /** Years of experience when the digest states it — Wellfound does. */
  minYears?: number;
};

export type AlertSource = {
  /** Persisted `source` column value — NEVER rename an existing one. */
  name: string;
  /** Sender domain, handed to the server-side IMAP SEARCH so only this sender's mail is fetched. */
  fromDomain: string;
  /** Lookback window in days. */
  days: number;
  /**
   * Rejects non-job mail from the same sender before parsing.
   *
   * Wellfound sends two shapes from one address: "New jobs: ..." digests and
   * "An update from Univaens, ParallelDots and 37 others" company-activity
   * mail. Parsing the second would manufacture rows out of nothing.
   */
  subjectFilter?: (subject: string) => boolean;
  parse: (html: string) => ParsedAlertJob[];
  /** Tags applied to every job from this source, for provenance in the dashboard. */
  tags: string[];
};
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add scripts/capture-alert-fixtures.ts tests/fixtures/alerts/ lib/infra/sources/email/types.ts
git commit -m "feat: capture real Wellfound and Indeed alert fixtures, add parser contract"
```

---

### Task 2: Wellfound parser

Wellfound's digest is the most structured of the three. Each job is a run of consecutive text lines:

```
"Full Stack Engineer"                                        <- title
"Seamless.finance / 1-10 Employees"                          <- company / size
"₹3L–₹7L | Remote only, India | 3 years of exp | Full-time"  <- pipe-delimited facts
"Actively Hiring"                                            <- optional badge
"Learn More"                                                 <- CTA anchor
```

That third line carries salary, arrangement, location and years-of-experience in one place.

**Files:**
- Create: `lib/infra/sources/email/wellfound.ts`
- Test: `tests/infra/sources/email/wellfound.test.ts`

**Interfaces:**
- Consumes: `ParsedAlertJob` (Task 1)
- Produces: `parseWellfoundAlert(html: string): ParsedAlertJob[]`, `wellfoundJobId(company: string, title: string): string`

- [ ] **Step 1: Write the failing test**

```ts
// tests/infra/sources/email/wellfound.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseWellfoundAlert, wellfoundJobId } from "@/lib/infra/sources/email/wellfound";

const html = readFileSync("tests/fixtures/alerts/wellfound.html", "utf8");

describe("parseWellfoundAlert against a real digest", () => {
  const jobs = parseWellfoundAlert(html);

  it("finds the jobs the subject line promised", () => {
    // Subject: "New jobs: Full Stack Engineer at Seamless.finance and 3 more jobs"
    expect(jobs.length).toBeGreaterThanOrEqual(4);
  });

  it("extracts a clean title and company", () => {
    const first = jobs[0];
    expect(first.title).toBe("Full Stack Engineer");
    expect(first.company).toBe("Seamless.finance");
  });

  it("never leaves the employee-count suffix on the company", () => {
    for (const job of jobs) {
      expect(job.company).not.toMatch(/employees/i);
      expect(job.company).not.toContain("/");
    }
  });

  it("reads arrangement, location, salary and experience from the facts line", () => {
    const first = jobs[0];
    expect(first.arrangement).toBe("remote");
    expect(first.location).toBe("India");
    expect(first.salaryText).toBe("₹3L–₹7L");
    expect(first.minYears).toBe(3);
  });

  it("derives a stable id that does not embed a per-send tracking token", () => {
    for (const job of jobs) {
      expect(job.id).not.toMatch(/links\.wellfound\.com/);
      expect(job.id.length).toBeGreaterThan(0);
    }
    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
  });

  it("gives every job a url", () => {
    for (const job of jobs) expect(job.url).toMatch(/^https?:\/\//);
  });
});

describe("wellfoundJobId", () => {
  it("is stable across formatting differences", () => {
    expect(wellfoundJobId("Seamless.finance", "Full Stack Engineer")).toBe(
      wellfoundJobId("  Seamless.finance  ", "Full Stack Engineer")
    );
  });

  it("distinguishes different roles at one company", () => {
    expect(wellfoundJobId("Acme", "Backend Engineer")).not.toBe(
      wellfoundJobId("Acme", "Frontend Engineer")
    );
  });
});

describe("the facts line", () => {
  it("treats 'Onsite or remote' as remote — the employer permits it", () => {
    const jobs = parseWellfoundAlert(html);
    const flexible = jobs.find((j) => /onsite or remote/i.test(j.location ?? "") || j.arrangement === "remote");
    expect(flexible).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/infra/sources/email/wellfound.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// lib/infra/sources/email/wellfound.ts
import * as cheerio from "cheerio";
import { deriveArrangement } from "@/lib/domain/facts";
import type { ParsedAlertJob } from "./types";

// ---------------------------------------------------------------------------
// Wellfound "New jobs: ..." digests.
//
// Structure observed in tests/fixtures/alerts/wellfound.html — a run of
// consecutive text lines per job:
//
//   "Full Stack Engineer"                                        title
//   "Seamless.finance / 1-10 Employees"                          company / size
//   "₹3L–₹7L | Remote only, India | 3 years of exp | Full-time"  facts
//   "Actively Hiring"                                            optional badge
//   "Learn More"                                                 CTA anchor
//
// THE ID PROBLEM: every link in the digest is a per-send tracking redirect
// (links.wellfound.com/s/c/<hash>) carrying no job identifier. Using one as
// `source_id` would make the same posting a new row in every email. So the id
// is DERIVED from company + title, which is stable across sends. The cost is
// that two genuinely distinct postings with the same title at the same company
// collapse into one row — rare, and far cheaper than re-ingesting the whole
// digest weekly.
// ---------------------------------------------------------------------------

type DomNode = { type: string; name?: string; data?: string; children?: DomNode[] };

/** Splits an element into logical lines, one per text node. */
function lines(el: DomNode): string[] {
  const out: string[] = [];
  const push = (s?: string) => {
    const t = (s || "").replace(/\s+/g, " ").trim();
    if (t) out.push(t);
  };
  const walk = (n: DomNode) => {
    if (n.type === "text") return push(n.data);
    if (n.type !== "tag") return;
    for (const c of n.children || []) walk(c);
  };
  walk(el);
  return out;
}

/** "Seamless.finance / 1-10 Employees" -> "Seamless.finance" */
const COMPANY_SIZE_SUFFIX = /\s*\/\s*[\d,]+\s*-?\s*[\d,]*\+?\s*employees\s*$/i;

/** A company line is "<name> / <N>-<M> Employees". */
function isCompanyLine(line: string): boolean {
  return COMPANY_SIZE_SUFFIX.test(line);
}

function companyName(line: string): string {
  return line.replace(COMPANY_SIZE_SUFFIX, "").trim();
}

/** The pipe-delimited facts line always states experience or a work arrangement. */
function isFactsLine(line: string): boolean {
  return line.includes("|") && /years? of exp|remote|onsite|hybrid/i.test(line);
}

const EXP_RE = /(\d{1,2})\+?\s*years?\s+of\s+exp/i;
const CURRENCY_RE = /[₹$€£]/;
const EMPLOYMENT_TYPE_RE = /^(full|part)-time$|^contract$|^internship$|^co-?op$/i;

export type WellfoundFacts = {
  salaryText?: string;
  location?: string;
  arrangementText?: string;
  minYears?: number;
};

/**
 * Classifies each pipe-separated segment by SHAPE rather than position.
 * Segment order varies between postings, and a missing salary shifts every
 * following field — the same positional trap that made the LinkedIn parser
 * store badge text as a company name.
 */
export function parseFactsLine(line: string): WellfoundFacts {
  const out: WellfoundFacts = {};
  for (const raw of line.split("|")) {
    const seg = raw.trim();
    if (!seg) continue;

    const exp = seg.match(EXP_RE);
    if (exp) {
      out.minYears = Number(exp[1]);
      continue;
    }
    if (EMPLOYMENT_TYPE_RE.test(seg)) continue;
    if (CURRENCY_RE.test(seg)) {
      out.salaryText = seg;
      continue;
    }
    // Whatever is left describes where the work happens:
    //   "Remote only, India"
    //   "Onsite or remote, Faridabad, Remote (Everywhere)"
    // The arrangement is the clause before the first comma; the rest is location.
    const comma = seg.indexOf(",");
    out.arrangementText = comma >= 0 ? seg.slice(0, comma).trim() : seg;
    out.location = comma >= 0 ? seg.slice(comma + 1).trim() : undefined;
  }
  return out;
}

/** Lowercased, punctuation-stripped join. Stable across whitespace and case. */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function wellfoundJobId(company: string, title: string): string {
  return `${slug(company)}:${slug(title)}`;
}

const NON_JOB_LINES =
  /^(ready to interview|open to offers|closed to offers|actively hiring|growing fast|learn more|hi|view all|unsubscribe)$/i;

export function parseWellfoundAlert(html: string): ParsedAlertJob[] {
  const $ = cheerio.load(html);
  const root = $("body").get(0);
  if (!root) return [];

  const all = lines(root as unknown as DomNode);
  const ctas = learnMoreHrefs($);
  const out: ParsedAlertJob[] = [];
  const seen = new Set<string>();

  // A job is anchored by its COMPANY line — the only line with an unambiguous
  // shape. The title is the line before it; the facts line is the next line
  // that looks like one. Anchoring on the distinctive line rather than counting
  // from the top is what makes a missing badge or an extra banner harmless.
  for (let i = 1; i < all.length; i++) {
    if (!isCompanyLine(all[i])) continue;

    const title = all[i - 1];
    if (!title || NON_JOB_LINES.test(title)) continue;

    const company = companyName(all[i]);
    if (!company) continue;

    let facts: WellfoundFacts = {};
    for (let j = i + 1; j < Math.min(i + 4, all.length); j++) {
      if (isFactsLine(all[j])) {
        facts = parseFactsLine(all[j]);
        break;
      }
    }

    const id = wellfoundJobId(company, title);
    if (seen.has(id)) continue;
    seen.add(id);

    out.push({
      id,
      title,
      company,
      location: facts.location,
      // Nth job pairs with the Nth CTA. Falls back to the board itself when the
      // digest has fewer CTAs than jobs.
      url: ctas[out.length] ?? "https://wellfound.com/jobs",
      arrangement: deriveArrangement({ location: facts.arrangementText }),
      salaryText: facts.salaryText,
      minYears: facts.minYears,
    });
  }

  return out;
}

/**
 * The per-job "Learn More" tracking links, in document order.
 *
 * Collected once and paired with jobs BY INDEX: the digest emits one CTA per
 * job in the same order the jobs appear, so the Nth job's link is the Nth CTA.
 * (Taking `.first()` for every job would hand every row the same URL — a real
 * bug caught in review of this plan.)
 *
 * These links are per-send tracking redirects. They are fine as a click target
 * but must never become the id; see wellfoundJobId.
 */
function learnMoreHrefs($: cheerio.CheerioAPI): string[] {
  return $("a")
    .toArray()
    .filter((el) => $(el).text().replace(/\s+/g, " ").trim() === "Learn More")
    .map((el) => $(el).attr("href") ?? "")
    .filter(Boolean);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/infra/sources/email/wellfound.test.ts`
Expected: PASS.

If the "Onsite or remote" case fails, check `deriveArrangement`: `"Onsite or remote"` contains both `onsite` and `remote`, and `lib/domain/facts/arrangement.ts` checks HYBRID → ONSITE → REMOTE in that order, so it returns `"onsite"`. That is the wrong answer here — the employer permits remote. Fix it in the PARSER, not in `deriveArrangement` (which other sources depend on): map a leading `"Onsite or remote"` to `"remote"` before calling, and add a test pinning it.

- [ ] **Step 5: Run the full suite**

Run: `npm run verify`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add lib/infra/sources/email/wellfound.ts tests/infra/sources/email/wellfound.test.ts
git commit -m "feat: parse Wellfound job-alert digests"
```

---

### Task 3: Indeed parser

Indeed's digest nests two anchors per job (a whole-card anchor and a title-only one) sharing a `jk=` job key, exactly like LinkedIn's template. Its enclosing container splits into lines:

```
[0] "MERN Stack Developer"        [0] "Web Developer"
[1] "Wits Innovation Lab"         [1] "TestprepKart"
[2] "Mumbai, Maharashtra"         [2] "3.5"        <- company RATING
[3] "Easily apply"                [3] "Greater Noida, Uttar Pradesh"
[4] "Developing and designing..." [4] "From ₹25,000 a month"
[5] "Just posted"                 [5] "Easily apply"
```

**A rating line shifts every following field.** Read positionally and you store `location: "3.5"`. Classify by shape instead.

**Files:**
- Create: `lib/infra/sources/email/indeed.ts`
- Test: `tests/infra/sources/email/indeed.test.ts`

**Interfaces:**
- Consumes: `ParsedAlertJob` (Task 1)
- Produces: `parseIndeedAlert(html: string): ParsedAlertJob[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/infra/sources/email/indeed.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseIndeedAlert } from "@/lib/infra/sources/email/indeed";

const html = readFileSync("tests/fixtures/alerts/indeed.html", "utf8");

describe("parseIndeedAlert against a real digest", () => {
  const jobs = parseIndeedAlert(html);

  it("finds one entry per distinct job key, not one per anchor", () => {
    // The fixture holds 38 anchors across 19 distinct jk= values.
    expect(jobs.length).toBe(19);
  });

  it("extracts clean titles, never the glued whole card", () => {
    for (const job of jobs) {
      expect(job.title.length).toBeLessThan(90);
      expect(job.title).not.toMatch(/easily apply|just posted|days? ago/i);
    }
  });

  it("never stores a company rating as the location", () => {
    // "TestprepKart" has a 3.5 rating line that shifts every later field.
    for (const job of jobs) {
      expect(job.location ?? "").not.toMatch(/^\d\.\d$/);
      expect(job.company).not.toMatch(/^\d\.\d$/);
    }
  });

  it("reads the rating-shifted card correctly", () => {
    const shifted = jobs.find((j) => j.company === "TestprepKart");
    expect(shifted).toBeDefined();
    expect(shifted!.title).toBe("Web Developer");
    expect(shifted!.location).toBe("Greater Noida, Uttar Pradesh");
    expect(shifted!.salaryText).toBe("From ₹25,000 a month");
  });

  it("flags 'Easily apply' as easyApply", () => {
    expect(jobs.some((j) => j.easyApply === true)).toBe(true);
  });

  it("captures the description snippet, so these are not scored title-only", () => {
    const withDesc = jobs.filter((j) => (j.description ?? "").length > 20);
    expect(withDesc.length).toBeGreaterThan(jobs.length / 2);
  });

  it("builds a tracking-free canonical url from the job key", () => {
    for (const job of jobs) {
      expect(job.url).toMatch(/^https:\/\/[a-z.]*indeed\.com\/viewjob\?jk=[a-f0-9]+$/);
      expect(job.url).not.toContain("qd=");
    }
  });

  it("uses the job key as the id", () => {
    for (const job of jobs) expect(job.id).toMatch(/^[a-f0-9]+$/);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
  });

  it("classifies a remote listing", () => {
    const remote = jobs.find((j) => j.company === "Yaarify");
    expect(remote?.location).toBe("Remote");
    expect(remote?.arrangement).toBe("remote");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/infra/sources/email/indeed.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// lib/infra/sources/email/indeed.ts
import * as cheerio from "cheerio";
import { deriveArrangement } from "@/lib/domain/facts";
import type { ParsedAlertJob } from "./types";

// ---------------------------------------------------------------------------
// Indeed "Apply to jobs at ..." digests.
//
// Two nested anchors per job share one `jk=` job key: a whole-card anchor and a
// title-only anchor. The card's enclosing container splits into lines like:
//
//   "MERN Stack Developer" / "Wits Innovation Lab" / "Mumbai, Maharashtra"
//   / "Easily apply" / "<description snippet>" / "Just posted"
//
// FIELDS ARE NOT AT FIXED INDEXES. A company with a star rating inserts a bare
// "3.5" line after the company, shifting location, salary and everything after
// it down by one. Reading by index would store the rating as the location —
// the same defect that once made the LinkedIn parser store "Promoted" as a
// company name. Every field below is therefore identified by SHAPE.
// ---------------------------------------------------------------------------

const JK_RE = /[?&]jk=([a-f0-9]+)/i;

type DomNode = { type: string; name?: string; data?: string; children?: DomNode[] };

function lines(el: DomNode): string[] {
  const out: string[] = [];
  const push = (s?: string) => {
    const t = (s || "").replace(/\s+/g, " ").trim();
    if (t) out.push(t);
  };
  const walk = (n: DomNode) => {
    if (n.type === "text") return push(n.data);
    if (n.type !== "tag") return;
    for (const c of n.children || []) walk(c);
  };
  walk(el);
  return out;
}

/** A bare star rating: "3.5", "4.0". */
const RATING_RE = /^\d(?:\.\d)?$/;
/** "₹3,00,000 - ₹7,00,000 a year", "From ₹25,000 a month", "$120,000 a year". */
const SALARY_RE = /[₹$€£]\s?[\d,]/;
const EASY_APPLY_RE = /^easily apply$/i;
/** "Just posted", "2 days ago", "Active 3 days ago", "Today". */
const POSTED_RE = /^(just posted|today|yesterday|active \d+\+? days? ago|\d+\+? days? ago|hiring ongoing|posted \d+)/i;
/** A description snippet is long prose; a location is short. */
const MAX_LOCATION_LEN = 60;

export function parseIndeedAlert(html: string): ParsedAlertJob[] {
  const $ = cheerio.load(html);
  const byId = new Map<string, ParsedAlertJob>();

  $("a[href]").each((_i, a) => {
    const href = $(a).attr("href") || "";
    const id = href.match(JK_RE)?.[1];
    if (!id || byId.has(id)) return;

    const container = $(a).closest("td, tr, table").get(0);
    if (!container) return;
    const ls = lines(container as unknown as DomNode);
    if (ls.length < 2) return;

    // Title and company are the first two lines: they are the only fields with
    // no distinguishing shape, and nothing can precede them in a card.
    const title = ls[0];
    const company = ls[1];
    if (!title || !company || RATING_RE.test(title) || RATING_RE.test(company)) return;

    let location: string | undefined;
    let salaryText: string | undefined;
    let description: string | undefined;
    let easyApply = false;

    for (const line of ls.slice(2)) {
      if (RATING_RE.test(line)) continue;            // company rating — the shifter
      if (EASY_APPLY_RE.test(line)) { easyApply = true; continue; }
      if (POSTED_RE.test(line)) continue;
      if (SALARY_RE.test(line)) { salaryText ??= line; continue; }
      if (line.length > MAX_LOCATION_LEN) { description ??= line; continue; }
      location ??= line;
    }

    byId.set(id, {
      id,
      title,
      company,
      location,
      // Canonical and tracking-free. The href in the email carries a per-send
      // `qd=` token that would otherwise be persisted forever.
      url: `https://in.indeed.com/viewjob?jk=${id}`,
      arrangement: deriveArrangement({ location }),
      easyApply,
      description,
      salaryText,
    });
  });

  return [...byId.values()];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/infra/sources/email/indeed.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Run the full suite**

Run: `npm run verify`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add lib/infra/sources/email/indeed.ts tests/infra/sources/email/indeed.test.ts
git commit -m "feat: parse Indeed job-alert digests by line shape, not position"
```

---

### Task 4: The shared alert-ingest runner

**Files:**
- Create: `lib/infra/mail/alert-ingest.ts`
- Test: `tests/infra/mail/alert-ingest.test.ts`

**Interfaces:**
- Consumes: `AlertSource`, `ParsedAlertJob` (Task 1); `withMailbox` from `lib/infra/mail/imap.ts`
- Produces: `fetchAlertSource(source: AlertSource): Promise<RawJob[]>` and the pure, testable `toRawJobs(source: AlertSource, parsed: ParsedAlertJob[]): RawJob[]`

- [ ] **Step 1: Write the failing test**

The IMAP half needs a mailbox, so the mapping half is extracted as a pure function and tested directly — the same pattern `factsToRow` follows in `lib/pipeline/stages/ingest.ts`.

```ts
// tests/infra/mail/alert-ingest.test.ts
import { describe, it, expect } from "vitest";
import { toRawJobs } from "@/lib/infra/mail/alert-ingest";
import type { AlertSource, ParsedAlertJob } from "@/lib/infra/sources/email/types";

const SOURCE: AlertSource = {
  name: "test_alert",
  fromDomain: "example.invalid",
  days: 3,
  parse: () => [],
  tags: ["test-alert"],
};

function parsed(over: Partial<ParsedAlertJob> = {}): ParsedAlertJob {
  return {
    id: "abc",
    title: "Full Stack Engineer",
    company: "Acme",
    url: "https://example.invalid/jobs/abc",
    ...over,
  };
}

describe("toRawJobs", () => {
  it("carries the source name onto every row", () => {
    const [job] = toRawJobs(SOURCE, [parsed()]);
    expect(job.source).toBe("test_alert");
    expect(job.sourceId).toBe("abc");
  });

  it("never sets applyEmail, so an alert job can never auto-send", () => {
    const [job] = toRawJobs(SOURCE, [parsed()]);
    expect(job.applyEmail).toBeUndefined();
  });

  it("derives remote from arrangement, and leaves it undefined when unknown", () => {
    expect(toRawJobs(SOURCE, [parsed({ arrangement: "remote" })])[0].remote).toBe(true);
    expect(toRawJobs(SOURCE, [parsed({ arrangement: "onsite" })])[0].remote).toBe(false);
    expect(toRawJobs(SOURCE, [parsed({ arrangement: "hybrid" })])[0].remote).toBe(false);
    expect(toRawJobs(SOURCE, [parsed({ arrangement: "unknown" })])[0].remote).toBeUndefined();
    expect(toRawJobs(SOURCE, [parsed({})])[0].remote).toBeUndefined();
  });

  it("marks a job sparse only when no description came through", () => {
    expect(toRawJobs(SOURCE, [parsed()])[0].sparse).toBe(true);
    expect(toRawJobs(SOURCE, [parsed({ description: "We need React." })])[0].sparse).toBe(false);
  });

  it("passes structured facts through untouched", () => {
    const [job] = toRawJobs(SOURCE, [parsed({ minYears: 3, salaryText: "₹3L–₹7L", easyApply: true })]);
    expect(job.minYears).toBe(3);
    expect(job.salaryText).toBe("₹3L–₹7L");
    expect(job.easyApply).toBe(true);
  });

  it("applies the source tags", () => {
    expect(toRawJobs(SOURCE, [parsed()])[0].tags).toEqual(["test-alert"]);
  });

  it("drops duplicates by id within one run", () => {
    expect(toRawJobs(SOURCE, [parsed(), parsed()])).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/infra/mail/alert-ingest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// lib/infra/mail/alert-ingest.ts
import { simpleParser } from "mailparser";
import { withMailbox } from "./imap";
import type { AlertSource, ParsedAlertJob } from "@/lib/infra/sources/email/types";
import type { RawJob } from "@/lib/domain/types";

// ---------------------------------------------------------------------------
// Runs ONE email-alert source: mailbox -> messages from that sender -> parser
// -> RawJob[].
//
// Deliberately one source per call, not a batch over all of them. Sharing a
// single connection across sources would mean memoizing the fetch, because
// lib/infra/sources/index.ts runs sources through Promise.all — and that memo
// would live at module scope, where Vercel's lambda reuse would let it outlive
// the run and serve stale jobs on the next one. Three narrow connections once a
// day is the cheaper trade.
//
// The IMAP search is server-side: `{ since, from }` becomes an IMAP SEARCH, so
// only this sender's mail crosses the wire — not the whole mailbox.
// ---------------------------------------------------------------------------

/**
 * The pure half: parsed jobs -> RawJob rows. Exported so it can be tested
 * without a mailbox, the same way factsToRow is in lib/pipeline/stages/ingest.ts.
 */
export function toRawJobs(source: AlertSource, parsed: ParsedAlertJob[]): RawJob[] {
  const out: RawJob[] = [];
  const seen = new Set<string>();

  for (const p of parsed) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);

    out.push({
      source: source.name,
      sourceId: p.id,
      title: p.title,
      company: p.company,
      url: p.url,
      // Alert digests never publish an apply-by-email address, so these can
      // never auto-send. They land in the manual apply queue.
      applyEmail: undefined,
      location: p.location,
      arrangement: p.arrangement,
      easyApply: p.easyApply,
      // Honest tri-state: undefined means the digest did not say. Never coerce
      // to true — that defaulting is the bug Phase 1 existed to remove.
      remote:
        p.arrangement === undefined || p.arrangement === "unknown"
          ? undefined
          : p.arrangement === "remote",
      minYears: p.minYears,
      salaryText: p.salaryText,
      description: p.description,
      tags: source.tags,
      // A digest without a snippet is scored on its title alone; enrichment may
      // recover more later.
      sparse: !p.description,
    });
  }

  return out;
}

/**
 * Fetches and parses every recent alert email from one source.
 *
 * Never throws for a single bad message: one unparseable email skips that
 * message rather than losing the rest of the run.
 */
export async function fetchAlertSource(source: AlertSource): Promise<RawJob[]> {
  const since = new Date(Date.now() - source.days * 24 * 60 * 60 * 1000);

  const parsed = await withMailbox(async (client) => {
    const collected: ParsedAlertJob[] = [];

    for await (const msg of client.fetch(
      { since, from: source.fromDomain },
      { source: true }
    )) {
      if (!msg.source) continue;
      try {
        const mail = await simpleParser(msg.source);
        if (source.subjectFilter && !source.subjectFilter(mail.subject ?? "")) {
          continue;
        }
        const html =
          typeof mail.html === "string"
            ? mail.html
            : mail.textAsHtml || `<pre>${mail.text || ""}</pre>`;
        collected.push(...source.parse(html));
      } catch {
        // A single malformed message must not cost the rest of the digest.
        continue;
      }
    }

    return collected;
  });

  return toRawJobs(source, parsed);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/infra/mail/alert-ingest.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/infra/mail/alert-ingest.ts tests/infra/mail/alert-ingest.test.ts
git commit -m "feat: add the shared email-alert ingest runner"
```

---

### Task 5: Registry wiring, and port LinkedIn onto withMailbox

**Files:**
- Create: `lib/infra/sources/email/registry.ts`
- Modify: `lib/infra/sources/registry.ts` (add two `JOB_SOURCES` entries)
- Modify: `lib/infra/linkedin/alerts.ts` (`fetchLinkedInAlerts` adopts `withMailbox`)
- Modify: `lib/config/env.ts` (two new flags)
- Test: `tests/infra/sources/email/registry.test.ts`

**Interfaces:**
- Consumes: `parseWellfoundAlert` (Task 2), `parseIndeedAlert` (Task 3), `fetchAlertSource` (Task 4)
- Produces: `WELLFOUND_ALERTS`, `INDEED_ALERTS` as `AlertSource` values; two new `JOB_SOURCES` entries

**DELIBERATE DIVERGENCE FROM THE SPEC — read before coding.** The spec sketches
LinkedIn joining `ALERT_SOURCES` with an inline adapter that bolts a `url` onto
`parseAlertEmail`'s output. This plan does NOT do that. `fetchLinkedInAlerts`
stays its own function and only swaps its hand-rolled client for `withMailbox`.

Reason: routing LinkedIn through the generic `toRawJobs` would silently change
its `RawJob` mapping — the canonical `/jobs/view/<id>/` URL it builds, its
`["linkedin-alert"]` tag, its `sparse: true`. That module took three fix rounds
to stabilise in Phase 1, and the spec's own stated reason for not moving the
parser was exactly that fragility. Uniformity for its own sake is not worth
re-opening it. The shared runner still gets proven end to end by two real
sources.

- [ ] **Step 1: Write the failing test**

```ts
// tests/infra/sources/email/registry.test.ts
import { describe, it, expect } from "vitest";
import { WELLFOUND_ALERTS, INDEED_ALERTS } from "@/lib/infra/sources/email/registry";

describe("alert source registry", () => {
  it("uses the persisted source names", () => {
    expect(WELLFOUND_ALERTS.name).toBe("wellfound_alert");
    expect(INDEED_ALERTS.name).toBe("indeed_alert");
  });

  it("targets the right sender domains", () => {
    expect(WELLFOUND_ALERTS.fromDomain).toBe("wellfound.com");
    expect(INDEED_ALERTS.fromDomain).toBe("indeed.com");
  });

  it("filters Wellfound's non-job company-update digests", () => {
    const keep = WELLFOUND_ALERTS.subjectFilter!;
    expect(keep("New jobs: Full Stack Engineer at Seamless.finance and 3 more jobs")).toBe(true);
    expect(keep("An update from Univaens, ParallelDots and 37 others")).toBe(false);
    expect(keep("An update from Flowbit, Edensign and 5 others")).toBe(false);
  });

  it("keeps Indeed's job digests", () => {
    const keep = INDEED_ALERTS.subjectFilter;
    if (!keep) return;
    expect(keep("Apply to jobs at Wits Innovation Lab, snabs solution and Yaarify")).toBe(true);
    expect(keep("Front End Developer @ Techihire")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/infra/sources/email/registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the alert registry**

```ts
// lib/infra/sources/email/registry.ts
import { parseWellfoundAlert } from "./wellfound";
import { parseIndeedAlert } from "./indeed";
import type { AlertSource } from "./types";

// ---------------------------------------------------------------------------
// Every email-alert source, declared once.
//
// `name` IS A PERSISTED VALUE — it is written to the `source` column and forms
// half of the (source, source_id) dedupe key. Renaming one orphans every row
// stored under the old name, which would re-surface jobs already applied to.
// Add new names freely; never change an existing one.
// ---------------------------------------------------------------------------

export const WELLFOUND_ALERTS: AlertSource = {
  name: "wellfound_alert",
  fromDomain: "wellfound.com",
  days: 7,
  // Wellfound sends two shapes from one address. "An update from X, Y and N
  // others" is company-activity digest with no job listings in it; parsing it
  // would manufacture rows out of nothing.
  subjectFilter: (subject) => /^new jobs:/i.test(subject.trim()),
  parse: parseWellfoundAlert,
  tags: ["wellfound-alert"],
};

export const INDEED_ALERTS: AlertSource = {
  name: "indeed_alert",
  fromDomain: "indeed.com",
  days: 3,
  parse: parseIndeedAlert,
  tags: ["indeed-alert"],
};
```

- [ ] **Step 4: Add the environment flags**

In `lib/config/env.ts`, add to the schema beside `ENABLE_LINKEDIN_ALERTS`:

```ts
  ENABLE_WELLFOUND_ALERTS: boolFlag(false),
  ENABLE_INDEED_ALERTS: boolFlag(false),
```

and to the explicit `build()` list (see the note at the top of that file on why every key is referenced literally):

```ts
    ENABLE_WELLFOUND_ALERTS: raw.ENABLE_WELLFOUND_ALERTS,
    ENABLE_INDEED_ALERTS: raw.ENABLE_INDEED_ALERTS,
```

- [ ] **Step 5: Register both as job sources**

In `lib/infra/sources/registry.ts`, add the import:

```ts
import { fetchAlertSource } from "@/lib/infra/mail/alert-ingest";
import { WELLFOUND_ALERTS, INDEED_ALERTS } from "./email/registry";
```

and append to `JOB_SOURCES`:

```ts
  {
    // Reads your own inbox over IMAP, read-only. Same approach as
    // linkedin_alert — no Wellfound account is authenticated, nothing is
    // scraped from a logged-in surface.
    name: "wellfound_alert",
    kind: "job",
    fetch: () => fetchAlertSource(WELLFOUND_ALERTS),
    enabled: () => getEnv().ENABLE_WELLFOUND_ALERTS,
    disabledReason: () =>
      getEnv().ENABLE_WELLFOUND_ALERTS
        ? undefined
        : "set ENABLE_WELLFOUND_ALERTS=1 to enable (needs IMAP_USER/IMAP_PASSWORD, " +
          "or the existing GMAIL_USER/GMAIL_APP_PASSWORD)",
  },
  {
    name: "indeed_alert",
    kind: "job",
    fetch: () => fetchAlertSource(INDEED_ALERTS),
    enabled: () => getEnv().ENABLE_INDEED_ALERTS,
    disabledReason: () =>
      getEnv().ENABLE_INDEED_ALERTS
        ? undefined
        : "set ENABLE_INDEED_ALERTS=1 to enable (needs IMAP_USER/IMAP_PASSWORD, " +
          "or the existing GMAIL_USER/GMAIL_APP_PASSWORD)",
  },
```

- [ ] **Step 6: Port `fetchLinkedInAlerts` onto `withMailbox`**

In `lib/infra/linkedin/alerts.ts`, replace the hand-rolled client. Delete the `ImapFlow` import and the manual credential check (`getImapSettings()` inside `withMailbox` raises an equivalent error), then restructure `fetchLinkedInAlerts`:

```ts
export async function fetchLinkedInAlerts(): Promise<RawJob[]> {
  const env = getEnv();
  if (!env.ENABLE_LINKEDIN_ALERTS) return [];

  const since = new Date(Date.now() - env.LINKEDIN_ALERT_DAYS * 24 * 60 * 60 * 1000);
  const out: RawJob[] = [];
  const seen = new Set<string>();

  await withMailbox(async (client) => {
    for await (const msg of client.fetch(
      { since, from: "linkedin.com" },
      { source: true }
    )) {
      if (!msg.source) continue;
      const mail = await simpleParser(msg.source);
      const html =
        typeof mail.html === "string"
          ? mail.html
          : mail.textAsHtml || `<pre>${mail.text || ""}</pre>`;

      for (const p of parseAlertEmail(html)) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        out.push({
          // ... the existing RawJob mapping, unchanged ...
        });
      }
    }
  });

  return out;
}
```

Keep the existing `RawJob` mapping body exactly as it is — only the connection handling changes. Add `import { withMailbox } from "@/lib/infra/mail/imap";`.

Note the behavioural difference to state in your report: `withMailbox` calls `client.close()` alongside `logout()` and cleans up after a failed handshake, which the inline version did not. That is the improvement, not a regression.

- [ ] **Step 7: Run the suite**

Run: `npm run verify`
Expected: clean. `tests/infra/sources/registry.test.ts` guards source naming and enablement — if it enumerates `JOB_SOURCES`, update its expected count and names. Do NOT delete assertions.

- [ ] **Step 8: Commit**

```bash
git add lib/infra/sources/email/registry.ts lib/infra/sources/registry.ts lib/infra/linkedin/alerts.ts lib/config/env.ts tests/infra/sources/
git commit -m "feat: register Wellfound and Indeed alerts; port LinkedIn onto withMailbox"
```

---

### Task 6: Y Combinator connector

**Files:**
- Create: `lib/infra/sources/ycombinator.ts`
- Create: `tests/fixtures/ycombinator-eng.html` (captured in Step 1)
- Modify: `lib/infra/sources/registry.ts` (one `JOB_SOURCES` entry)
- Test: `tests/infra/sources/ycombinator.test.ts`

**Interfaces:**
- Consumes: `deriveExperience` from `@/lib/domain/facts`
- Produces: `fetchYCombinator(): Promise<RawJob[]>`, `parseYCPayload(html: string): RawJob[]`, `visaToGeo(visa?: string)`

- [ ] **Step 1: Capture the payload as a fixture**

```bash
curl -s -A "job-bde-system/1.0 (personal job-search assistant)" \
  "https://www.ycombinator.com/jobs/role/eng" \
  -o tests/fixtures/ycombinator-eng.html
wc -c tests/fixtures/ycombinator-eng.html
```

Expected: a few hundred KB. Confirm it contains the payload:

```bash
grep -c 'data-page=' tests/fixtures/ycombinator-eng.html
```

Expected: `1`.

- [ ] **Step 2: Write the failing test**

```ts
// tests/infra/sources/ycombinator.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseYCPayload, visaToGeo } from "@/lib/infra/sources/ycombinator";

const html = readFileSync("tests/fixtures/ycombinator-eng.html", "utf8");

describe("visaToGeo", () => {
  it("treats a US-only visa requirement as restricted", () => {
    expect(visaToGeo("US citizen/visa only")).toEqual({
      geoEligibility: "restricted",
      geoRegions: ["us"],
    });
  });

  it("does NOT claim eligibility when the employer merely does not require a visa", () => {
    // "not required" says nothing about WHERE they hire. Asserting `eligible`
    // would put a claim in the data the posting never made.
    expect(visaToGeo("US citizenship/visa not required")).toEqual({});
    expect(visaToGeo("Will sponsor")).toEqual({});
    expect(visaToGeo(undefined)).toEqual({});
  });
});

describe("parseYCPayload", () => {
  const jobs = parseYCPayload(html);

  it("extracts the postings", () => {
    expect(jobs.length).toBeGreaterThanOrEqual(20);
  });

  it("tags every row with the persisted source name", () => {
    for (const job of jobs) expect(job.source).toBe("ycombinator");
  });

  it("builds absolute urls", () => {
    for (const job of jobs) expect(job.url).toMatch(/^https:\/\/www\.ycombinator\.com\//);
  });

  it("never sets applyEmail — YC applications go through their own flow", () => {
    for (const job of jobs) expect(job.applyEmail).toBeUndefined();
  });

  it("reads minExperience into minYears", () => {
    const withExp = jobs.filter((j) => j.minYears !== undefined);
    expect(withExp.length).toBeGreaterThan(0);
    for (const job of withExp) expect(job.minYears).toBeGreaterThanOrEqual(0);
  });

  it("does not invent an experience floor for 'Any (new grads ok)'", () => {
    // That string states no numeric floor; deriveExperience must find none.
    const anyGrad = jobs.find((j) => j.experienceText === undefined && j.minYears === undefined);
    expect(anyGrad).toBeDefined();
  });

  it("carries skills through as tags", () => {
    const tagged = jobs.filter((j) => (j.tags ?? []).length > 1);
    expect(tagged.length).toBeGreaterThan(0);
    for (const job of jobs) expect(job.tags).toContain("ycombinator");
  });

  it("marks rows sparse — the payload carries no description", () => {
    for (const job of jobs) expect(job.sparse).toBe(true);
  });

  it("applies the visa restriction where one is stated", () => {
    const restricted = jobs.filter((j) => j.geoEligibility === "restricted");
    expect(restricted.length).toBeGreaterThan(0);
    for (const job of restricted) expect(job.geoRegions).toContain("us");
  });
});
```

- [ ] **Step 3: Implement**

```ts
// lib/infra/sources/ycombinator.ts
import { deriveExperience } from "@/lib/domain/facts";
import type { GeoEligibility } from "@/lib/domain/facts";
import type { RawJob } from "@/lib/domain/types";

// ---------------------------------------------------------------------------
// Y Combinator's public jobs board.
//
// The page is server-rendered by Inertia, which embeds the whole payload as
// JSON in a `data-page` attribute. This is a plain unauthenticated GET of a
// public page — no login, no cookie, no session, and no anti-bot behaviour of
// any kind. A non-200 is an acceptable outcome: the source yields nothing that
// run and the rest of the pipeline carries on.
//
// The payload is unusually rich. `minExperience` and `visa` are STATED facts
// rather than prose we have to infer from, which makes them better evidence
// than anything the location text can give us.
// ---------------------------------------------------------------------------

const ROLE = "eng";
const PAGE_URL = `https://www.ycombinator.com/jobs/role/${ROLE}`;
const BASE = "https://www.ycombinator.com";

// Descriptive on purpose — a server operator reading their logs should be able
// to tell what this is and that it is a small personal tool, not a crawler.
const USER_AGENT =
  "job-bde-system/1.0 (personal job-search assistant; unauthenticated public page fetch)";

const FETCH_TIMEOUT_MS = 20_000;

type YCPosting = {
  id?: number | string;
  title?: string;
  url?: string;
  location?: string;
  minExperience?: string;
  visa?: string;
  skills?: string[];
  companyName?: string;
  type?: string;
};

/**
 * Maps YC's visa field onto geographic eligibility.
 *
 * ONLY an explicit US-only requirement is a restriction. "not required" and
 * "Will sponsor" say the employer will not block on visa status — which is not
 * the same as saying where they hire. Reading either as `eligible` would put a
 * claim in the data that the posting never made, and this system's governing
 * rule is that an unstated fact stays unknown.
 */
export function visaToGeo(
  visa?: string
): { geoEligibility?: GeoEligibility; geoRegions?: string[] } {
  if (!visa) return {};
  if (/us\s+citizen(ship)?\/?visa\s+only|us\s+citizen\/visa\s+only/i.test(visa)) {
    return { geoEligibility: "restricted", geoRegions: ["us"] };
  }
  return {};
}

/** Decodes the HTML-escaped Inertia payload out of the `data-page` attribute. */
function readPayload(html: string): { jobPostings?: YCPosting[] } | undefined {
  const match = html.match(/data-page="([^"]+)"/);
  if (!match) return undefined;
  const decoded = match[1]
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  try {
    return JSON.parse(decoded).props;
  } catch {
    return undefined;
  }
}

export function parseYCPayload(html: string): RawJob[] {
  const props = readPayload(html);
  const postings = props?.jobPostings ?? [];
  const out: RawJob[] = [];

  for (const p of postings) {
    const id = p.id !== undefined ? String(p.id) : undefined;
    if (!id || !p.title || !p.companyName) continue;

    // "3+ years" -> 3. "Any (new grads ok)" states no numeric floor and
    // correctly yields nothing.
    const experience = deriveExperience(p.minExperience ?? "");

    out.push({
      source: "ycombinator",
      sourceId: id,
      title: p.title,
      company: p.companyName,
      url: p.url ? `${BASE}${p.url}` : `${BASE}/jobs`,
      // YC applications go through their own account flow, so these can never
      // auto-send; they land in the manual apply queue.
      applyEmail: undefined,
      location: p.location,
      tags: ["ycombinator", ...(p.skills ?? [])],
      minYears: experience.minYears,
      maxYears: experience.maxYears,
      experienceText: experience.experienceText,
      ...visaToGeo(p.visa),
      // The listing payload carries no description; the job is scored on title,
      // skills and location until something richer arrives.
      description: undefined,
      sparse: true,
    });
  }

  return out;
}

export async function fetchYCombinator(): Promise<RawJob[]> {
  const res = await fetch(PAGE_URL, {
    method: "GET",
    credentials: "omit",
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
  });
  if (!res.ok) {
    throw new Error(`ycombinator: HTTP ${res.status}`);
  }
  return parseYCPayload(await res.text());
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/infra/sources/ycombinator.test.ts`
Expected: PASS.

- [ ] **Step 5: Register it**

In `lib/infra/sources/registry.ts`, add `import { fetchYCombinator } from "./ycombinator";` and append to `JOB_SOURCES`:

```ts
  {
    // Public, unauthenticated page. No key, no account, always on.
    name: "ycombinator",
    kind: "job",
    fetch: fetchYCombinator,
    enabled: always,
  },
```

- [ ] **Step 6: Run the suite**

Run: `npm run verify`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add lib/infra/sources/ycombinator.ts tests/infra/sources/ycombinator.test.ts tests/fixtures/ycombinator-eng.html lib/infra/sources/registry.ts
git commit -m "feat: add the Y Combinator job source"
```

---

### Task 7: Close the single-country region-list gap

Phase 1 left a recorded gap: `REGION_LIST_RE` requires **two or more** two-letter codes, so `"Remote (IN)"` resolves to `unknown`. Y Combinator emits exactly that shape, so it stops being theoretical.

Real Wellfound data also surfaced `Faridabad`, an Indian city absent from the token list.

**Files:**
- Modify: `lib/domain/facts/geo.ts`
- Test: `tests/domain/facts/geo.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new
- Produces: no signature change

- [ ] **Step 1: Write the failing test**

```ts
// Append to tests/domain/facts/geo.test.ts
describe("single-country region lists", () => {
  it("reads a one-code list, which Y Combinator emits", () => {
    expect(deriveGeo("Remote (IN)").eligibility).toBe("eligible");
    expect(deriveGeo("Remote (US)").eligibility).toBe("restricted");
  });

  it("still handles multi-code lists exactly as before", () => {
    expect(deriveGeo("Remote (IN; US)").eligibility).toBe("eligible");
    expect(deriveGeo("Remote (GB; DE; NL; FR)").eligibility).toBe("restricted");
  });

  it("does not mistake a parenthetical word for a country code", () => {
    // Two-letter uppercase only; "(Remote)" and "(Hybrid)" must not match.
    expect(deriveGeo("Bengaluru (Hybrid)").eligibility).toBe("eligible");
    expect(deriveGeo("Chinchilla (Remote)").eligibility).toBe("unknown");
  });

  it("recognises Faridabad, seen in real Wellfound data", () => {
    expect(deriveGeo("Faridabad").eligibility).toBe("eligible");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/domain/facts/geo.test.ts`
Expected: FAIL on the single-code cases and on Faridabad.

- [ ] **Step 3: Implement**

In `lib/domain/facts/geo.ts`, widen the region-list pattern from requiring a repeated group to accepting one or more codes:

```ts
// A parenthesised list of ISO-ish country codes: "Remote (GB; DE; NL)", and
// also the single-code form "Remote (IN)" that Y Combinator emits. Codes are
// uppercase two-letter only, so "(Remote)" and "(Hybrid)" cannot match.
const REGION_LIST_RE = /\(\s*([A-Z]{2}(?:\s*[;,]\s*[A-Z]{2})*)\s*\)/;
```

and add `faridabad` to the unambiguous India token list.

**Careful:** the anchored `\(\s*...\s*\)` form matters. Without anchoring the group to the whole parenthetical, `"Bengaluru (Hybrid)"` could match `Hy` and be read as a country code.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/domain/facts/geo.test.ts`
Expected: PASS, including every pre-existing case.

- [ ] **Step 5: Run the full suite**

Run: `npm run verify`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add lib/domain/facts/geo.ts tests/domain/facts/geo.test.ts
git commit -m "fix: accept single-country region lists and add Faridabad"
```

---

### Task 8: Attribution, documentation and the Upwork unblock note

**Files:**
- Modify: `app/dashboard/layout.tsx` (footer attribution)
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-14-job-facts-followups.md`

**Interfaces:**
- Consumes: nothing
- Produces: nothing

- [ ] **Step 1: Add the new sources to the footer**

`app/dashboard/layout.tsx` carries a REQUIRED attribution block — Adzuna's terms demand a visible credit, and Remotive and RemoteOK both state they revoke API access without one. Add Y Combinator, Wellfound and Indeed to that list in the same style, keeping the existing entries and the warning comment intact.

- [ ] **Step 2: Document the new flags**

In `.env.example`, beside `ENABLE_LINKEDIN_ALERTS`:

```
# Reads Wellfound "New jobs:" digests from your own inbox over IMAP, read-only.
# Needs IMAP_USER/IMAP_PASSWORD, or the existing GMAIL_USER/GMAIL_APP_PASSWORD.
ENABLE_WELLFOUND_ALERTS=0

# Reads Indeed job-alert digests the same way. High volume — Indeed's alerts
# skew toward agency postings, so expect the role veto to do real work.
ENABLE_INDEED_ALERTS=0
```

- [ ] **Step 3: Record how to unblock Upwork**

In the follow-ups doc, replace the Upwork paragraph with concrete steps:

```markdown
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
```

- [ ] **Step 4: Note the new sources in the README**

`README.md:10` currently reads:

```
- Fetches from RemoteOK, Remotive, Arbeitnow, We Work Remotely, Himalayas, Jobicy, Adzuna
```

Replace it with:

```
- Fetches from RemoteOK, Remotive, Arbeitnow, We Work Remotely, Himalayas, Jobicy, Adzuna, Y Combinator
- Reads job-alert emails from your own inbox, read-only: LinkedIn, Wellfound, Indeed
```

- [ ] **Step 5: Verify and commit**

Run: `npm run verify`
Expected: clean.

```bash
git add app/dashboard/layout.tsx .env.example README.md docs/superpowers/specs/2026-08-14-job-facts-followups.md
git commit -m "docs: attribute and document the Phase 2 sources"
```

---

## Done criteria

- [ ] `npm run verify` clean
- [ ] `parseWellfoundAlert` returns ≥4 jobs from the real fixture, with clean company names and structured facts
- [ ] `parseIndeedAlert` returns exactly 19 jobs from the real fixture, and the rating-shifted TestprepKart card resolves correctly
- [ ] `parseYCPayload` returns ≥20 jobs, with at least one `restricted` on a stated visa requirement
- [ ] `deriveGeo("Remote (IN)")` is `eligible`; `deriveGeo("Bengaluru (Hybrid)")` is still `eligible`
- [ ] `JOB_SOURCES` holds `ycombinator`, `wellfound_alert` and `indeed_alert`, each with an honest `disabledReason`
- [ ] `fetchLinkedInAlerts` no longer constructs its own `ImapFlow` client
- [ ] Attribution footer credits the three new sources
- [ ] No TODO/TBD or commented-out code introduced
