# Job Facts & Resume-Aware Matching — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single, always-true `remote` flag with two honestly-derived axes — work arrangement and geographic eligibility — plus a years-of-experience range, and rank jobs against them.

**Architecture:** A new pure `lib/domain/facts/` module derives structured facts from raw job text. Ingest persists them into additive new columns; scoring consumes them as bounded post-normalization adjustments. The LinkedIn alert parser is rewritten for the current single-anchor card template, and a repair function recovers the 107 already-corrupt rows from their own stored text.

**Tech Stack:** TypeScript, Next.js 16, Drizzle ORM on libSQL/Turso, Vitest, cheerio, zod.

**Spec:** `docs/superpowers/specs/2026-08-14-job-facts-matching-design.md`

## Global Constraints

- **`domain/` never imports `infra/`.** Everything in `lib/domain/facts/` must be a pure function over plain data, unit-testable with no database and no network.
- **`unknown` is never guessed.** A fact the posting does not state is recorded as `unknown`/`undefined`, and scores as neither bonus nor penalty.
- **Source `name` values in `lib/infra/sources/registry.ts` are persisted.** Never rename an existing one.
- **Migrations are additive only.** Every statement is `ALTER TABLE ... ADD COLUMN` or `CREATE INDEX`. No column drops, no type changes, no table rebuilds.
- **The existing suite must stay green.** `tests/domain/scoring/score.test.ts` (1096 lines) is the guard against regressing the skill matcher. Run `npm test` before every commit.
- **Verification command:** `npm run verify` (= `lint` + `typecheck` + `test`).
- **Never weaken the role veto.** `ROLE_VETO_PHRASES` stays fatal (score 0).
- **No anti-bot behavior may be added** to any LinkedIn fetch — no proxy rotation, no UA spoofing, no retry storms. A 403/429 is an acceptable outcome.

---

### Task 1: Capture a real LinkedIn alert email as a test fixture

The current parser broke because it was written against an assumed HTML shape. Task 9 must not repeat that. This task fetches one real alert email, read-only, and freezes it as a fixture.

**STOP — operator confirmation required before running the script in Step 3.** It opens the operator's Gmail over IMAP. It is read-only (`readOnly: true`, matching the existing connector), but ask first.

**Files:**
- Create: `scripts/capture-linkedin-fixture.ts`
- Create: `tests/fixtures/linkedin-alert.html` (generated output, committed)

**Interfaces:**
- Consumes: nothing
- Produces: `tests/fixtures/linkedin-alert.html` — a real LinkedIn alert email body, used by Task 9.

- [ ] **Step 1: Write the capture script**

```ts
// scripts/capture-linkedin-fixture.ts
//
// Saves ONE real LinkedIn alert email to tests/fixtures/linkedin-alert.html so
// the parser in lib/infra/linkedin/alerts.ts can be written and tested against
// the template LinkedIn actually sends, rather than an assumed one.
//
// Read-only: the mailbox is opened with readOnly: true, so nothing is marked
// read and nothing is mutated. Run it once, commit the fixture, and this
// script never needs to run again.
//
//   npx tsx scripts/capture-linkedin-fixture.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { existsSync } from "node:fs";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

// tsx does not load .env. Node 22's built-in loader does, with no dependency —
// this is the same approach scripts/db-target.ts takes, and for the same reason:
// a script that silently runs against the wrong configuration reports success
// while doing nothing useful.
if (existsSync(".env")) process.loadEnvFile(".env");

const OUT = "tests/fixtures/linkedin-alert.html";

async function main() {
  const user = process.env.IMAP_USER ?? process.env.GMAIL_USER;
  const pass = process.env.IMAP_PASSWORD ?? process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error(
      "No IMAP credentials. Set IMAP_USER/IMAP_PASSWORD or GMAIL_USER/GMAIL_APP_PASSWORD."
    );
  }

  const client = new ImapFlow({
    host: process.env.IMAP_HOST ?? "imap.gmail.com",
    port: Number(process.env.IMAP_PORT ?? 993),
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock(
      process.env.IMAP_MAILBOX ?? "INBOX",
      { readOnly: true }
    );
    try {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      let saved = false;
      for await (const msg of client.fetch(
        { since, from: "linkedin.com" },
        { source: true }
      )) {
        if (!msg.source) continue;
        const mail = await simpleParser(msg.source);
        const html = typeof mail.html === "string" ? mail.html : undefined;
        // Alert digests are large and contain several /jobs/view/ links. A
        // one-link email is a different template (e.g. a single InMail).
        const links = html?.match(/jobs\/view\/\d+/g)?.length ?? 0;
        if (!html || links < 3) continue;
        mkdirSync("tests/fixtures", { recursive: true });
        writeFileSync(OUT, html, "utf8");
        console.log(
          `Saved ${OUT} (${html.length} bytes, ${links} job links, subject: ${mail.subject})`
        );
        saved = true;
        break;
      }
      if (!saved) {
        throw new Error(
          "No LinkedIn alert email with 3+ job links found in the last 30 days. " +
            "Check that job alerts are enabled and delivered to this mailbox."
        );
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error("CAPTURE FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
```

- [ ] **Step 2: ASK THE OPERATOR, then run the capture**

Ask: *"Ready to read one LinkedIn alert email from your Gmail, read-only, to save as a test fixture. Go ahead?"* Wait for a yes.

Run: `npx tsx scripts/capture-linkedin-fixture.ts`
Expected: `Saved tests/fixtures/linkedin-alert.html (NNNNN bytes, N job links, subject: ...)`

- [ ] **Step 3: Inspect the fixture and record the real card structure**

Run: `node -e "const h=require('fs').readFileSync('tests/fixtures/linkedin-alert.html','utf8'); const m=[...h.matchAll(/<a[^>]*jobs\/view\/(\d+)[^>]*>([\s\S]{0,400}?)<\/a>/g)]; console.log('anchors:', m.length); m.slice(0,3).forEach(x=>console.log('---\n'+x[2].replace(/<[^>]+>/g,'|').replace(/\s+/g,' ').trim()));"`

Write what you observe into a comment block at the top of the fixture-consuming test in Task 9. If the structure differs from the `Title Company · Location (Arrangement) badges` shape assumed there, **stop and report it** — the Task 9 algorithm needs revising before it is written.

- [ ] **Step 4: Commit**

```bash
git add scripts/capture-linkedin-fixture.ts tests/fixtures/linkedin-alert.html
git commit -m "test: capture a real LinkedIn alert email as a parser fixture"
```

---

### Task 2: Experience extraction

Move the years-of-experience regexes out of `score.ts`, where their result is collapsed to a boolean and discarded, into a module that returns the numbers.

**Files:**
- Create: `lib/domain/facts/types.ts`
- Create: `lib/domain/facts/experience.ts`
- Test: `tests/domain/facts/experience.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `deriveExperience(text: string): ExperienceFacts` where `ExperienceFacts = { minYears?: number; maxYears?: number; experienceText?: string }`. Also the shared `WorkArrangement`, `GeoEligibility`, `JobFacts` types in `types.ts`.

- [ ] **Step 1: Write the types**

```ts
// lib/domain/facts/types.ts
//
// Structured facts derived from a job posting's own words.
//
// Every field is optional or has an explicit `unknown` member, because the
// governing rule of this module is that a fact the posting does not state is
// recorded as unknown — never inferred, never defaulted to the common case.
// That is the same discipline inferRemote() already applied to remoteness; this
// module widens it to the axes that actually decide whether a job is takeable.

/**
 * Where the work physically happens.
 *
 * Four states, not a boolean: `hybrid` requires office presence and so is not
 * remote, but it is also not the same as fully on-site, and collapsing the two
 * loses the distinction the operator filters on.
 */
export type WorkArrangement = "remote" | "hybrid" | "onsite" | "unknown";

/**
 * Whether someone based in India can actually take the role.
 *
 * Deliberately independent of WorkArrangement. "Remote, USA" and "Remote,
 * Worldwide" are both fully remote and only one of them is takeable — that
 * conflation is what this type exists to end.
 */
export type GeoEligibility =
  | "worldwide"   // no restriction stated
  | "eligible"    // explicitly includes India/APAC, or the role is IN India
  | "restricted"  // explicitly excludes — "US only", "EU residents"
  | "unknown";

export type ExperienceFacts = {
  /** The binding floor the posting states. undefined when it states none. */
  minYears?: number;
  /** Upper bound, only when the posting states a range. */
  maxYears?: number;
  /** The exact phrase matched, so the dashboard can show its evidence. */
  experienceText?: string;
};

export type JobFacts = ExperienceFacts & {
  arrangement: WorkArrangement;
  geoEligibility: GeoEligibility;
  /** Normalized region tokens: ["worldwide"], ["us"], ["in","apac"]. */
  geoRegions: string[];
  /** LinkedIn one-click apply. undefined when the source cannot tell. */
  easyApply?: boolean;
};
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/domain/facts/experience.test.ts
import { describe, it, expect } from "vitest";
import { deriveExperience } from "@/lib/domain/facts/experience";

describe("deriveExperience", () => {
  it("reads a plus-form floor", () => {
    expect(deriveExperience("We want 8+ years of experience")).toMatchObject({
      minYears: 8,
      maxYears: undefined,
    });
  });

  it("reads a hyphenated range", () => {
    expect(deriveExperience("3-5 years building web apps")).toMatchObject({
      minYears: 3,
      maxYears: 5,
    });
  });

  // Taken verbatim from a real LinkedIn card in production.
  it("reads a 'N to M Years' range", () => {
    expect(
      deriveExperience("Gen AI / LLM Backend Developer - 2 to 5 Years")
    ).toMatchObject({ minYears: 2, maxYears: 5 });
  });

  it("reads an 'at least' floor", () => {
    expect(deriveExperience("at least 6 years in React")).toMatchObject({
      minYears: 6,
    });
  });

  it("returns nothing when no requirement is stated", () => {
    expect(deriveExperience("A great place to work")).toEqual({});
  });

  // Preserves the deliberate exclusion documented in score.ts: a bare "N years"
  // is a company blurb, not a seniority bar.
  it("ignores a bare 'N years' company blurb", () => {
    expect(deriveExperience("Serving clients for over 10 years")).toEqual({});
  });

  it("does not read 110+ years as 10+ years", () => {
    expect(deriveExperience("110+ years of heritage")).toEqual({});
  });

  // Parity with the old requiresTooManyYears(): a posting stating several
  // floors is asking for the highest of them.
  it("takes the highest stated floor when several appear", () => {
    const facts = deriveExperience("3+ years overall, 9+ years with Java");
    expect(facts.minYears).toBe(9);
  });

  it("pairs maxYears with the winning floor", () => {
    const facts = deriveExperience("1-2 years support, or 6-9 years engineering");
    expect(facts).toMatchObject({ minYears: 6, maxYears: 9 });
  });

  it("reports the phrase it matched", () => {
    expect(deriveExperience("we need 8+ years").experienceText).toContain("8+");
  });

  it("is case insensitive and handles yrs", () => {
    expect(deriveExperience("MINIMUM OF 7 YRS")).toMatchObject({ minYears: 7 });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/domain/facts/experience.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/domain/facts/experience"`

- [ ] **Step 4: Implement**

```ts
// lib/domain/facts/experience.ts
import type { ExperienceFacts } from "./types";

// ---------------------------------------------------------------------------
// Years-of-experience requirements, read out of a posting's own words.
//
// These patterns moved here from lib/domain/scoring/score.ts, where they were
// already correct but their result was collapsed to a single boolean
// ("requires 8+ years?") and the numbers thrown away. The numbers are what the
// dashboard needs to filter on, so they are kept.
//
// A bare "10 years" is deliberately NOT a requirement: "founded 10 years ago"
// and "serving clients for over 10 years" are company blurbs, not seniority
// bars, and they are common enough that matching them would misfire often.
// `(?<!\d)` is what stops "110+ years" being read as "10+ years".
// ---------------------------------------------------------------------------

type Match = { min: number; max?: number; text: string };

const YEARS = String.raw`(?:years?|yrs?)`;

/** "3-5 years", "6 – 9 yrs" — the lower bound is the requirement. */
const RANGE_RE = new RegExp(
  String.raw`(?<!\d)(\d{1,2})\s*[-–—]\s*(\d{1,2})\s*${YEARS}(?![a-z])`,
  "gi"
);

/** "2 to 5 Years" — seen verbatim in LinkedIn card titles. */
const TO_RANGE_RE = new RegExp(
  String.raw`(?<!\d)(\d{1,2})\s+to\s+(\d{1,2})\s*${YEARS}(?![a-z])`,
  "gi"
);

/** "8+ years", "10 or more years" */
const PLUS_RE = new RegExp(
  String.raw`(?<!\d)(\d{1,2})\s*(?:\+|or\s+more)\s*${YEARS}(?![a-z])`,
  "gi"
);

/** "at least 10 years", "minimum of 10 years", "min. 10 yrs" */
const AT_LEAST_RE = new RegExp(
  String.raw`(?:at\s+least|minimum(?:\s+of)?|min\.?)\s+(?<!\d)(\d{1,2})\s*${YEARS}(?![a-z])`,
  "gi"
);

function collect(text: string): Match[] {
  const out: Match[] = [];
  const scan = (re: RegExp, withMax: boolean) => {
    // These regexes are module-level and /g, so lastIndex must be reset or a
    // previous call would leak its cursor into this one.
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      out.push({
        min: Number(m[1]),
        max: withMax ? Number(m[2]) : undefined,
        text: m[0].trim(),
      });
    }
  };
  scan(RANGE_RE, true);
  scan(TO_RANGE_RE, true);
  scan(PLUS_RE, false);
  scan(AT_LEAST_RE, false);
  return out;
}

/**
 * The experience requirement a posting states, or `{}` when it states none.
 *
 * When several floors appear ("3+ years overall, 9+ years with Java") the
 * HIGHEST is taken: the posting is genuinely asking for nine years of
 * something, and that is the bar an applicant is measured against. This also
 * preserves the behavior of the requiresTooManyYears() predicate this replaced,
 * which fired if ANY stated floor was too high.
 */
export function deriveExperience(text: string): ExperienceFacts {
  if (!text) return {};
  const matches = collect(text);
  if (matches.length === 0) return {};

  let winner = matches[0];
  for (const m of matches) if (m.min > winner.min) winner = m;

  return {
    minYears: winner.min,
    maxYears: winner.max,
    experienceText: winner.text,
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/domain/facts/experience.test.ts`
Expected: PASS, 10 tests

- [ ] **Step 6: Commit**

```bash
git add lib/domain/facts/types.ts lib/domain/facts/experience.ts tests/domain/facts/experience.test.ts
git commit -m "feat: extract years-of-experience requirements as structured facts"
```

---

### Task 3: Work arrangement extraction

**Files:**
- Create: `lib/domain/facts/arrangement.ts`
- Test: `tests/domain/facts/arrangement.test.ts`

**Interfaces:**
- Consumes: `WorkArrangement` from `./types`
- Produces: `deriveArrangement(input: ArrangementInput): WorkArrangement` where `ArrangementInput = { location?: string; tags?: string[]; remote?: boolean }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/domain/facts/arrangement.test.ts
import { describe, it, expect } from "vitest";
import { deriveArrangement } from "@/lib/domain/facts/arrangement";

describe("deriveArrangement", () => {
  // Strings taken verbatim from production LinkedIn cards.
  it("reads (On-site) from a location suffix", () => {
    expect(deriveArrangement({ location: "Bengaluru (On-site)" })).toBe("onsite");
  });

  it("reads (Hybrid) from a location suffix", () => {
    expect(
      deriveArrangement({ location: "Pune/Pimpri-Chinchwad Area (Hybrid)" })
    ).toBe("hybrid");
  });

  it("reads (Remote) from a location suffix", () => {
    expect(deriveArrangement({ location: "India (Remote)" })).toBe("remote");
  });

  it("prefers hybrid over onsite when both words appear", () => {
    expect(deriveArrangement({ location: "Hybrid - 3 days on-site" })).toBe(
      "hybrid"
    );
  });

  it("treats a bare city as unknown, not onsite", () => {
    expect(deriveArrangement({ location: "Gurgaon, Haryana, India" })).toBe(
      "unknown"
    );
  });

  it("honours an explicit source flag when the location is silent", () => {
    expect(
      deriveArrangement({ location: "Gurgaon, Haryana, India", remote: true })
    ).toBe("remote");
  });

  it("lets the location override a contradicting source flag", () => {
    // Remote-only boards hardcode remote:true. If the location says on-site,
    // the location is the more specific evidence.
    expect(deriveArrangement({ location: "Bengaluru (On-site)", remote: true })).toBe(
      "onsite"
    );
  });

  it("reads a remote tag", () => {
    expect(deriveArrangement({ tags: ["remote", "react"] })).toBe("remote");
  });

  it("is unknown with no evidence at all", () => {
    expect(deriveArrangement({})).toBe("unknown");
  });

  it("recognises worldwide phrasing as remote", () => {
    expect(deriveArrangement({ location: "Anywhere in the World" })).toBe(
      "remote"
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/domain/facts/arrangement.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// lib/domain/facts/arrangement.ts
import type { WorkArrangement } from "./types";

// ---------------------------------------------------------------------------
// Where the work physically happens.
//
// This absorbs inferRemote() from lib/infra/linkedin/alerts.ts and widens its
// boolean-plus-undefined result to four states. LinkedIn states the
// arrangement inside the location line — "Bengaluru (On-site)", "Pune Division
// (Hybrid)", "India (Remote)" — which is why location is the primary evidence.
//
// The job DESCRIPTION is deliberately NOT scanned. Descriptions mention
// "hybrid" and "remote" in passing constantly ("our hybrid cloud", "remote
// procedure call", "we were remote-first until 2022"), and every such mention
// would produce a confident wrong answer. Every source this system reads either
// states the arrangement in the location line or is a remote-only board that
// sets the flag, so the description adds noise and no signal.
// ---------------------------------------------------------------------------

const HYBRID_RE = /\bhybrid\b/i;
const ONSITE_RE = /\b(on[\s-]?site|onsite|in[\s-]?office|in\s+person)\b/i;
const REMOTE_RE =
  /\b(remote|work from home|wfh|anywhere|worldwide|distributed|telecommute)\b/i;

export type ArrangementInput = {
  location?: string;
  tags?: string[];
  /** What the source asserted, if anything. Remote-only boards hardcode true. */
  remote?: boolean;
};

/**
 * Precedence, most specific evidence first:
 *   1. the location line, where LinkedIn and most boards state it explicitly
 *   2. tags
 *   3. the source's own flag
 *   4. unknown
 *
 * Hybrid is tested before on-site and remote because a hybrid posting usually
 * names all three ("Hybrid — 3 days on-site, 2 remote") and hybrid is the
 * answer that carries the most information.
 */
export function deriveArrangement(input: ArrangementInput): WorkArrangement {
  const fromText = (text?: string): WorkArrangement | undefined => {
    if (!text) return undefined;
    if (HYBRID_RE.test(text)) return "hybrid";
    if (ONSITE_RE.test(text)) return "onsite";
    if (REMOTE_RE.test(text)) return "remote";
    return undefined;
  };

  return (
    fromText(input.location) ??
    fromText((input.tags ?? []).join(" ")) ??
    (input.remote === true ? "remote" : input.remote === false ? "onsite" : undefined) ??
    "unknown"
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/domain/facts/arrangement.test.ts`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add lib/domain/facts/arrangement.ts tests/domain/facts/arrangement.test.ts
git commit -m "feat: derive four-state work arrangement from location evidence"
```

---

### Task 4: Geographic eligibility extraction

The highest-value task in the plan: this is what separates "Remote, USA" from "Remote, Worldwide".

**Files:**
- Create: `lib/domain/facts/geo.ts`
- Test: `tests/domain/facts/geo.test.ts`

**Interfaces:**
- Consumes: `GeoEligibility` from `./types`
- Produces: `deriveGeo(location?: string): { regions: string[]; eligibility: GeoEligibility }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/domain/facts/geo.test.ts
import { describe, it, expect } from "vitest";
import { deriveGeo } from "@/lib/domain/facts/geo";

describe("deriveGeo", () => {
  // All strings below are real `location` values from the production database.
  it("treats worldwide phrasing as unrestricted", () => {
    expect(deriveGeo("Anywhere in the World")).toEqual({
      regions: ["worldwide"],
      eligibility: "worldwide",
    });
    expect(deriveGeo("Worldwide").eligibility).toBe("worldwide");
  });

  it("treats a US-only remote role as restricted", () => {
    expect(deriveGeo("USA")).toEqual({ regions: ["us"], eligibility: "restricted" });
    expect(deriveGeo("Remote - US").eligibility).toBe("restricted");
  });

  it("treats Europe and LATAM as restricted", () => {
    expect(deriveGeo("Europe").eligibility).toBe("restricted");
    expect(deriveGeo("LATAM").eligibility).toBe("restricted");
    expect(deriveGeo("Remote UK").eligibility).toBe("restricted");
  });

  it("treats an Indian city as eligible", () => {
    expect(deriveGeo("Bengaluru, Karnataka, India")).toEqual({
      regions: ["in"],
      eligibility: "eligible",
    });
    expect(deriveGeo("Gurgaon, Haryana, India").eligibility).toBe("eligible");
  });

  it("recognises Indian cities without the country name", () => {
    expect(deriveGeo("Mohali district").eligibility).toBe("eligible");
    expect(deriveGeo("Pune Division").eligibility).toBe("eligible");
    expect(deriveGeo("Noida").eligibility).toBe("eligible");
  });

  it("treats APAC as eligible", () => {
    expect(deriveGeo("APAC").eligibility).toBe("eligible");
  });

  it("is eligible when a multi-region list includes India", () => {
    expect(deriveGeo("Remote (US; IN; DE)").eligibility).toBe("eligible");
  });

  it("is restricted when a multi-region list excludes India", () => {
    expect(deriveGeo("Remote (GB; DE; NL; FR)").eligibility).toBe("restricted");
  });

  it("is unknown for an unrecognised place", () => {
    expect(deriveGeo("Chinchilla")).toEqual({ regions: [], eligibility: "unknown" });
  });

  it("is unknown for a missing or empty location", () => {
    expect(deriveGeo(undefined).eligibility).toBe("unknown");
    expect(deriveGeo("").eligibility).toBe("unknown");
  });

  it("tolerates the trailing-comma junk Adzuna emits", () => {
    // Real value: "Bedford, " — a bare city, so still unknown, but it must not
    // throw or produce a stray empty region token.
    expect(deriveGeo("Bedford, ")).toEqual({ regions: [], eligibility: "unknown" });
  });

  it("prefers worldwide over an incidental country mention", () => {
    expect(deriveGeo("Remote, Worldwide (US timezone overlap)").eligibility).toBe(
      "worldwide"
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/domain/facts/geo.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// lib/domain/facts/geo.ts
import type { GeoEligibility } from "./types";

// ---------------------------------------------------------------------------
// Can somebody based in India actually take this job?
//
// This is the question the system was failing to ask. Of 623 stored jobs every
// single one was marked remote, so "Remote, USA" and "Remote, Anywhere in the
// World" ranked identically — and roughly a sixth of the ranked list was roles
// the operator cannot be hired for.
//
// Remoteness and eligibility are independent (see ./arrangement.ts), so this
// module reads ONLY the geographic restriction and says nothing about where the
// work happens.
//
// INEVITABLY INCOMPLETE: this is a token list, not a geocoder. An unrecognised
// place yields `unknown` — no bonus, no penalty — rather than a guess. Adding a
// city here is cheap; guessing wrong is not.
// ---------------------------------------------------------------------------

const WORLDWIDE_RE =
  /\b(worldwide|anywhere|global(?:ly)?|international|any\s+country|no\s+location\s+restriction)\b/i;

/** Indian cities that appear in LinkedIn alerts without the country name. */
const INDIA_RE =
  /\b(india|bengaluru|bangalore|mumbai|new\s+delhi|delhi|gurgaon|gurugram|noida|pune|hyderabad|chennai|kolkata|ahmedabad|mohali|chandigarh|jaipur|dehradun|indore|kochi|coimbatore|nagpur|surat|lucknow|bhopal|vadodara|thiruvananthapuram|mysuru|mysore|jamshedpur|ranchi|kharagpur|tikamgarh|krishnagiri|wayanad|ajmer|rajkot)\b/i;

const APAC_RE = /\b(apac|asia[\s-]?pacific|asia)\b/i;

// Regions that exclude India when named as the restriction.
const RESTRICTED: { token: string; re: RegExp }[] = [
  { token: "us", re: /\b(usa?|u\.s\.a?\.?|united\s+states|america|americas)\b/i },
  { token: "ca", re: /\b(canada|canadian)\b/i },
  { token: "uk", re: /\b(uk|u\.k\.|united\s+kingdom|great\s+britain|england|scotland|wales)\b/i },
  { token: "eu", re: /\b(eu|europe|european|emea|eea)\b/i },
  { token: "latam", re: /\b(latam|latin\s+america|south\s+america)\b/i },
  { token: "anz", re: /\b(australia|new\s+zealand|anz)\b/i },
];

// ISO-ish codes inside a multi-region list: "Remote (GB; DE; NL)".
const REGION_LIST_RE = /\(([^)]*[A-Z]{2}(?:\s*[;,]\s*[A-Z]{2})+[^)]*)\)/;

export type GeoFacts = { regions: string[]; eligibility: GeoEligibility };

/**
 * Precedence matters and is deliberate:
 *   1. worldwide wins outright — "Remote, Worldwide (US timezone overlap)" is
 *      unrestricted, and an incidental "US" must not downgrade it
 *   2. an explicit region list is read for IN before anything else
 *   3. India / APAC -> eligible
 *   4. a named excluding region -> restricted
 *   5. otherwise unknown
 */
export function deriveGeo(location?: string): GeoFacts {
  const text = (location ?? "").replace(/[\s,]+$/, "").trim();
  if (!text) return { regions: [], eligibility: "unknown" };

  if (WORLDWIDE_RE.test(text)) {
    return { regions: ["worldwide"], eligibility: "worldwide" };
  }

  // "Remote (GB; DE; NL)" — an explicit allow-list of countries.
  const list = text.match(REGION_LIST_RE)?.[1];
  if (list) {
    const codes = list
      .split(/[;,]/)
      .map((c) => c.trim().toLowerCase())
      .filter((c) => /^[a-z]{2}$/.test(c));
    if (codes.length) {
      return codes.includes("in")
        ? { regions: codes, eligibility: "eligible" }
        : { regions: codes, eligibility: "restricted" };
    }
  }

  const regions: string[] = [];
  if (INDIA_RE.test(text)) regions.push("in");
  if (APAC_RE.test(text)) regions.push("apac");
  if (regions.length) return { regions, eligibility: "eligible" };

  for (const { token, re } of RESTRICTED) {
    if (re.test(text)) regions.push(token);
  }
  if (regions.length) return { regions, eligibility: "restricted" };

  return { regions: [], eligibility: "unknown" };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/domain/facts/geo.test.ts`
Expected: PASS, 12 tests

- [ ] **Step 5: Commit**

```bash
git add lib/domain/facts/geo.ts tests/domain/facts/geo.test.ts
git commit -m "feat: derive India-eligibility from a job's stated location"
```

---

### Task 5: The facts entry point

**Files:**
- Create: `lib/domain/facts/index.ts`
- Test: `tests/domain/facts/index.test.ts`

**Interfaces:**
- Consumes: `deriveExperience`, `deriveArrangement`, `deriveGeo`
- Produces: `deriveJobFacts(job: JobFactsInput): JobFacts` and `FACTS_VERSION: number`. `JobFactsInput` is structurally satisfied by `RawJob`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/domain/facts/index.test.ts
import { describe, it, expect } from "vitest";
import { deriveJobFacts, FACTS_VERSION } from "@/lib/domain/facts";

describe("deriveJobFacts", () => {
  it("combines all three axes", () => {
    expect(
      deriveJobFacts({
        title: "Senior Engineer",
        location: "Bengaluru (Hybrid)",
        description: "You have 4-7 years of experience.",
      })
    ).toMatchObject({
      arrangement: "hybrid",
      geoEligibility: "eligible",
      geoRegions: ["in"],
      minYears: 4,
      maxYears: 7,
    });
  });

  it("scans title and description together for experience", () => {
    expect(
      deriveJobFacts({ title: "Backend Developer - 2 to 5 Years", location: "India" })
    ).toMatchObject({ minYears: 2, maxYears: 5 });
  });

  it("returns unknowns rather than guesses for an empty job", () => {
    expect(deriveJobFacts({ title: "" })).toEqual({
      arrangement: "unknown",
      geoEligibility: "unknown",
      geoRegions: [],
      minYears: undefined,
      maxYears: undefined,
      experienceText: undefined,
      easyApply: undefined,
    });
  });

  it("does not overwrite facts the source already supplied", () => {
    // Y Combinator (Phase 2) supplies minExperience directly; a source that
    // knows a fact must win over re-deriving it from prose.
    const facts = deriveJobFacts({
      title: "Engineer",
      location: "Remote",
      minYears: 3,
      easyApply: true,
    });
    expect(facts.minYears).toBe(3);
    expect(facts.easyApply).toBe(true);
  });

  it("exposes a positive integer version", () => {
    expect(Number.isInteger(FACTS_VERSION)).toBe(true);
    expect(FACTS_VERSION).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/domain/facts/index.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// lib/domain/facts/index.ts
import { deriveArrangement } from "./arrangement";
import { deriveGeo } from "./geo";
import { deriveExperience } from "./experience";
import type { JobFacts } from "./types";

export * from "./types";
export { deriveArrangement } from "./arrangement";
export { deriveGeo } from "./geo";
export { deriveExperience } from "./experience";

/**
 * Bump when any extractor's behavior changes.
 *
 * Rows persist the version they were derived under, so `scripts/backfill-facts.ts`
 * re-derives only rows below the current number. That is what makes improving an
 * extractor a routine change rather than a one-shot event: edit, bump, backfill.
 */
export const FACTS_VERSION = 1;

export type JobFactsInput = {
  title?: string;
  description?: string;
  location?: string;
  tags?: string[];
  remote?: boolean;
} & Partial<JobFacts>;

/**
 * Derives every fact a posting supports.
 *
 * Facts the SOURCE already supplied are preserved, never recomputed: Y
 * Combinator publishes `minExperience` and Himalayas publishes
 * `locationRestrictions` as structured fields, and a regex over prose is
 * strictly worse evidence than the board's own data.
 *
 * This is also the seam an LLM fallback would occupy: it would run here, after
 * the rules, over only the fields still unknown.
 */
export function deriveJobFacts(job: JobFactsInput): JobFacts {
  const experience =
    job.minYears !== undefined
      ? { minYears: job.minYears, maxYears: job.maxYears, experienceText: job.experienceText }
      : deriveExperience([job.title, job.description].filter(Boolean).join("\n"));

  const geo =
    job.geoEligibility !== undefined
      ? { eligibility: job.geoEligibility, regions: job.geoRegions ?? [] }
      : deriveGeo(job.location);

  return {
    arrangement:
      job.arrangement ??
      deriveArrangement({ location: job.location, tags: job.tags, remote: job.remote }),
    geoEligibility: geo.eligibility,
    geoRegions: geo.regions,
    minYears: experience.minYears,
    maxYears: experience.maxYears,
    experienceText: experience.experienceText,
    easyApply: job.easyApply,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/domain/facts/`
Expected: PASS — all four facts test files

- [ ] **Step 5: Commit**

```bash
git add lib/domain/facts/index.ts tests/domain/facts/index.test.ts
git commit -m "feat: add deriveJobFacts entry point with a version stamp"
```

---

### Task 6: Persist the facts — RawJob fields and schema migration

**Files:**
- Modify: `lib/domain/types.ts` (add optional fact fields to `RawJob`)
- Modify: `lib/infra/db/schema.ts:22-89` (add columns + index to `jobs`)
- Create: `lib/infra/db/migrations/0001_*.sql` (generated)

**Interfaces:**
- Consumes: `JobFacts` from Task 5
- Produces: `schema.jobs.arrangement`, `.geoEligibility`, `.geoRegions`, `.minYears`, `.maxYears`, `.experienceText`, `.easyApply`, `.factsVersion`. `RawJob` gains the same fields, all optional.

- [ ] **Step 1: Extend `RawJob`**

In `lib/domain/types.ts`, add to the `RawJob` type, after `sparse`:

```ts
  // --- Structured facts (lib/domain/facts) -------------------------------
  // Optional because a SOURCE may supply them directly — Y Combinator
  // publishes minExperience and a visa restriction, Himalayas publishes
  // locationRestrictions. deriveJobFacts() fills in only what is left
  // undefined, so a board's own data always beats a regex over its prose.
  arrangement?: WorkArrangement;
  geoEligibility?: GeoEligibility;
  geoRegions?: string[];
  minYears?: number;
  maxYears?: number;
  experienceText?: string;
  easyApply?: boolean;
```

And at the top of the file:

```ts
import type { WorkArrangement, GeoEligibility } from "./facts/types";
```

- [ ] **Step 2: Add the columns to the schema**

In `lib/infra/db/schema.ts`, inside the `jobs` table definition, replace the `remote` line with:

```ts
    /**
     * DEPRECATED — read by nothing. `arrangement` is the source of truth.
     *
     * Kept for one phase so this migration stays additive: SQLite cannot alter
     * a column, and rebuilding a live table on Turso is risk with no benefit.
     * It is still WRITTEN, and now written honestly — null when the arrangement
     * is unknown, instead of the `.default(true)` that made all 623 rows in the
     * database claim to be remote.
     */
    remote: integer("remote", { mode: "boolean" }),
```

and add after the `descriptionSource` line:

```ts
    // --- structured facts (lib/domain/facts) ------------------------------
    arrangement: text("arrangement"), // remote | hybrid | onsite | unknown
    geoEligibility: text("geo_eligibility"), // worldwide | eligible | restricted | unknown
    geoRegions: text("geo_regions", { mode: "json" }).$type<string[]>().default([]),
    minYears: integer("min_years"),
    maxYears: integer("max_years"),
    experienceText: text("experience_text"),
    easyApply: integer("easy_apply", { mode: "boolean" }),
    // Which extractor version produced the fields above. backfill-facts.ts
    // re-derives only rows below the current FACTS_VERSION.
    factsVersion: integer("facts_version").notNull().default(0),
```

and add to the index array at the end of the table:

```ts
    index("jobs_facts_idx").on(t.geoEligibility, t.arrangement, t.score),
    index("jobs_facts_version_idx").on(t.factsVersion),
```

- [ ] **Step 3: Generate the migration**

Run: `npm run db:generate`
Expected: a new `lib/infra/db/migrations/0001_*.sql`

- [ ] **Step 4: Verify the migration is additive**

Run: `cat lib/infra/db/migrations/0001_*.sql`

Expected: only `ALTER TABLE \`jobs\` ADD \`...\`` and `CREATE INDEX` statements.

**STOP if you see any of:** `DROP TABLE`, `CREATE TABLE \`__new_jobs\``, `INSERT INTO \`__new_jobs\``, or `DROP COLUMN`. That is drizzle-kit choosing a table rebuild, which this plan forbids against a live database. If it happens, hand-write the migration as plain `ALTER TABLE ... ADD COLUMN` statements instead and re-run Step 5.

Note: removing `.default(true)` from `remote` is the change most likely to trigger a rebuild. If it does, leave `.default(true)` on the column, keep the deprecation comment, and rely on ingest always passing an explicit value (Task 7) — the default then never applies.

- [ ] **Step 5: Apply the migration locally, then verify**

```bash
npx tsx scripts/migrate.ts
```

Expected: `Done. N tables: ...`

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean

- [ ] **Step 7: Commit**

```bash
git add lib/domain/types.ts lib/infra/db/schema.ts lib/infra/db/migrations/
git commit -m "feat: add structured job-fact columns, additive migration only"
```

---

### Task 7: Wire facts into ingest and stop Adzuna asserting remoteness

**Files:**
- Modify: `lib/pipeline/stages/ingest.ts:186-227` (the insert block)
- Modify: `lib/infra/sources/adzuna.ts:114`
- Test: `tests/pipeline/ingest-facts.test.ts`

**Interfaces:**
- Consumes: `deriveJobFacts`, `FACTS_VERSION` (Task 5); the schema columns (Task 6)
- Produces: rows in `jobs` carrying populated fact columns

- [ ] **Step 1: Write the failing test**

```ts
// tests/pipeline/ingest-facts.test.ts
import { describe, it, expect } from "vitest";
import { deriveJobFacts } from "@/lib/domain/facts";
import type { RawJob } from "@/lib/domain/types";

// ingest.ts builds its insert payload from deriveJobFacts(). This test pins the
// exact translation, which is where the original bug lived: `remote ?? true`
// silently overwrote a deliberate tri-state and made every one of 623 rows
// claim to be remote.
function insertValues(raw: RawJob) {
  const facts = deriveJobFacts(raw);
  return {
    arrangement: facts.arrangement,
    remote:
      facts.arrangement === "unknown" ? null : facts.arrangement === "remote",
  };
}

describe("ingest fact translation", () => {
  it("stores an on-site job as not remote", () => {
    const row = insertValues({
      source: "linkedin_alert",
      sourceId: "1",
      title: "Engineer",
      company: "Acme",
      url: "https://example.invalid/1",
      location: "Bengaluru (On-site)",
    });
    expect(row.arrangement).toBe("onsite");
    expect(row.remote).toBe(false);
  });

  it("stores an unknown arrangement as null, never true", () => {
    const row = insertValues({
      source: "adzuna",
      sourceId: "2",
      title: "Engineer",
      company: "Acme",
      url: "https://example.invalid/2",
      location: "Bedford, ",
    });
    expect(row.arrangement).toBe("unknown");
    expect(row.remote).toBeNull();
  });

  it("still stores a genuine remote job as remote", () => {
    const row = insertValues({
      source: "himalayas",
      sourceId: "3",
      title: "Engineer",
      company: "Acme",
      url: "https://example.invalid/3",
      location: "Anywhere in the World",
      remote: true,
    });
    expect(row.arrangement).toBe("remote");
    expect(row.remote).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/pipeline/ingest-facts.test.ts`
Expected: FAIL — the second case returns `true`, not `null`, until `deriveJobFacts` is wired in (or PASS immediately if Task 5 is already correct; if so, proceed — the test is a regression guard).

- [ ] **Step 3: Wire facts into the insert**

In `lib/pipeline/stages/ingest.ts`, add the import:

```ts
import { deriveJobFacts, FACTS_VERSION } from "@/lib/domain/facts";
```

and replace the `batch.map((raw) => ({ ... }))` payload's `remote:` line and add the fact fields. The mapper becomes:

```ts
          batch.map((raw) => {
            const facts = deriveJobFacts(raw);
            return {
              source: raw.source,
              sourceId: raw.sourceId,
              title: raw.title,
              company: raw.company,
              companyUrl: raw.companyUrl,
              url: raw.url,
              applyEmail: raw.applyEmail,
              location: raw.location,
              // Honest, and derived rather than defaulted. The previous
              // `raw.remote ?? true` here (plus a `.default(true)` on the
              // column) is why every stored row claimed to be remote.
              remote:
                facts.arrangement === "unknown"
                  ? null
                  : facts.arrangement === "remote",
              arrangement: facts.arrangement,
              geoEligibility: facts.geoEligibility,
              geoRegions: facts.geoRegions,
              minYears: facts.minYears,
              maxYears: facts.maxYears,
              experienceText: facts.experienceText,
              easyApply: facts.easyApply,
              factsVersion: FACTS_VERSION,
              salaryText: raw.salaryText,
              tags: raw.tags || [],
              description: raw.description,
              postedAt: raw.postedAt,
              fingerprint: raw.fingerprint,
              sources: raw.contributing,
              descriptionSource: raw.description ? "source" : undefined,
              status: "found" as const,
              stage: raw.description ? ("score" as const) : ("enrich" as const),
            };
          })
```

- [ ] **Step 4: Stop Adzuna asserting remoteness from a regex hint**

In `lib/infra/sources/adzuna.ts`, change line 114 from `remote: true,` to:

```ts
          // Adzuna has no remote field; the REMOTE_HINT filter above only says
          // the listing MENTIONS remote work, which is not the same as being
          // remote. Left undefined so lib/domain/facts classifies it honestly
          // rather than this source asserting something it does not know.
          remote: undefined,
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. If `tests/infra/sources/*.test.ts` asserts `remote: true` for Adzuna, update that assertion to `undefined` — the old value was the bug.

- [ ] **Step 6: Commit**

```bash
git add lib/pipeline/stages/ingest.ts lib/infra/sources/adzuna.ts tests/pipeline/ingest-facts.test.ts
git commit -m "fix: stop coercing every ingested job to remote=true"
```

---

### Task 8: Fit-aware scoring

**Files:**
- Modify: `lib/domain/scoring/resume-profile.ts` (add `CAREER_START`, `yearsOfExperience`)
- Modify: `lib/domain/scoring/score.ts:75-113` (remove the years guard), `:244-340` (`scoreJob`)
- Modify: `lib/pipeline/stages/score.ts:38-56` (pass the new fields through)
- Test: `tests/domain/scoring/fit.test.ts`

**Interfaces:**
- Consumes: `JobFacts` fields on `RawJob` (Task 6)
- Produces: `scoreJob` unchanged in signature — `(job: RawJob) => { score: number; reasons: string[] }` — but now applying fit adjustments. Also exports `fitAdjustment(job, years): { delta: number; reasons: string[] }` for testing.

- [ ] **Step 1: Add a computed years-of-experience to the resume profile**

In `lib/domain/scoring/resume-profile.ts`, above `CANDIDATE`:

```ts
// Ribhu's continuous professional start date (Nature Technologies, SWE).
// Derived rather than written as prose, because the prose figure in CANDIDATE
// .summary below is the one number this system asserts that the CV does not,
// and a hardcoded "nearly 3 years" rots silently as time passes.
export const CAREER_START = new Date("2023-12-01T00:00:00Z");

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/** Years of professional experience as of `now`. */
export function yearsOfExperience(now: Date = new Date()): number {
  return Math.max(0, (now.getTime() - CAREER_START.getTime()) / MS_PER_YEAR);
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/domain/scoring/fit.test.ts
import { describe, it, expect } from "vitest";
import { scoreJob, fitAdjustment } from "@/lib/domain/scoring/score";
import { yearsOfExperience } from "@/lib/domain/scoring/resume-profile";
import type { RawJob } from "@/lib/domain/types";

function makeJob(overrides: Partial<RawJob> = {}): RawJob {
  return {
    source: "test",
    sourceId: "job-1",
    title: "Full Stack Engineer",
    company: "Acme",
    url: "https://example.invalid/job-1",
    description: "React, TypeScript and Node.js.",
    ...overrides,
  };
}

describe("fitAdjustment", () => {
  const YEARS = 3;

  it("penalises a geographically restricted role", () => {
    const { delta, reasons } = fitAdjustment(
      makeJob({ geoEligibility: "restricted", geoRegions: ["us"] }),
      YEARS
    );
    expect(delta).toBe(-25);
    expect(reasons.join(" ")).toMatch(/not open to your location/i);
  });

  it("rewards a worldwide role", () => {
    expect(fitAdjustment(makeJob({ geoEligibility: "worldwide" }), YEARS).delta).toBe(8);
  });

  it("gives unknown eligibility neither bonus nor penalty", () => {
    expect(fitAdjustment(makeJob({ geoEligibility: "unknown" }), YEARS).delta).toBe(0);
  });

  it("penalises an experience floor well above yours", () => {
    expect(fitAdjustment(makeJob({ minYears: 8 }), YEARS).delta).toBe(-20);
  });

  it("tolerates a floor within two years of yours", () => {
    expect(fitAdjustment(makeJob({ minYears: 5 }), YEARS).delta).toBe(0);
  });

  it("rewards a range that brackets your experience", () => {
    expect(fitAdjustment(makeJob({ minYears: 2, maxYears: 5 }), YEARS).delta).toBe(6);
  });

  it("rewards remote and penalises on-site, without hiding either", () => {
    expect(fitAdjustment(makeJob({ arrangement: "remote" }), YEARS).delta).toBe(5);
    expect(fitAdjustment(makeJob({ arrangement: "onsite" }), YEARS).delta).toBe(-8);
    expect(fitAdjustment(makeJob({ arrangement: "hybrid" }), YEARS).delta).toBe(-8);
    expect(fitAdjustment(makeJob({ arrangement: "unknown" }), YEARS).delta).toBe(0);
  });

  it("sums independent dimensions", () => {
    const { delta } = fitAdjustment(
      makeJob({ geoEligibility: "worldwide", arrangement: "remote", minYears: 2, maxYears: 5 }),
      YEARS
    );
    expect(delta).toBe(8 + 5 + 6);
  });
});

describe("scoreJob with facts", () => {
  it("ranks an India-eligible remote role above an identical US-only one", () => {
    const base = { description: "React, TypeScript, Node.js, Next.js." };
    const eligible = scoreJob(
      makeJob({ ...base, geoEligibility: "worldwide", arrangement: "remote" })
    );
    const restricted = scoreJob(
      makeJob({ ...base, geoEligibility: "restricted", arrangement: "remote" })
    );
    expect(eligible.score).toBeGreaterThan(restricted.score);
  });

  it("never drops a hybrid India role to zero — it stays filterable", () => {
    const result = scoreJob(
      makeJob({
        description: "React, TypeScript, Node.js, Next.js, agentic AI, LLM, RAG.",
        geoEligibility: "eligible",
        arrangement: "hybrid",
      })
    );
    expect(result.score).toBeGreaterThan(0);
  });

  it("still returns 0 for a vetoed role regardless of perfect facts", () => {
    const result = scoreJob(
      makeJob({
        title: "Technical Recruiter",
        description: "React, TypeScript, Node.js.",
        geoEligibility: "worldwide",
        arrangement: "remote",
      })
    );
    expect(result.score).toBe(0);
  });

  it("keeps the score inside 0-100", () => {
    const result = scoreJob(
      makeJob({
        description: "React TypeScript Node.js Next.js Flutter LLM RAG MCP agentic AI",
        geoEligibility: "worldwide",
        arrangement: "remote",
        minYears: 2,
        maxYears: 5,
      })
    );
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});

describe("yearsOfExperience", () => {
  it("computes from the career start date", () => {
    expect(yearsOfExperience(new Date("2026-12-01T00:00:00Z"))).toBeCloseTo(3, 1);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/domain/scoring/fit.test.ts`
Expected: FAIL — `fitAdjustment` is not exported

- [ ] **Step 4: Implement `fitAdjustment` and wire it into `scoreJob`**

In `lib/domain/scoring/score.ts`:

Delete `OVER_EXPERIENCED_YEARS`, `OVER_EXPERIENCED_REASON`, `YEARS_REQUIREMENT_PATTERNS` and `requiresTooManyYears` (lines 75-113) — they now live in `lib/domain/facts/experience.ts`. Add the import:

```ts
import { yearsOfExperience } from "./resume-profile";
import type { RawJob, RawLead } from "@/lib/domain/types";
```

Add, above `scoreJob`:

```ts
// ---------------------------------------------------------------------------
// Fit adjustments
//
// Applied to the NORMALIZED 0-100 score, not to the raw accumulator, and this
// is deliberate. The divisor at the bottom of scoreJob multiplies a raw point by
// roughly 2.9, so the old `raw -= 15` for an internship was really -43 points of
// the final score — a magnitude nobody chose. Expressing these in real points
// makes each one legible and independently tunable, and leaves the skill curve
// (which the comment on FULL_CREDIT_FRACTION warns not to retune without
// outcome data) completely untouched.
//
// None of these is fatal. The operator asked to SEE hybrid and on-site roles and
// filter them, not to have them silently discarded — the one fatal rule in this
// file remains the role veto.
// ---------------------------------------------------------------------------

/** A stated floor this far above the candidate's years is a filter they fail. */
const EXPERIENCE_TOLERANCE_YEARS = 2;

const GEO_RESTRICTED_PENALTY = -25;
const GEO_ELIGIBLE_BONUS = 8;
const EXPERIENCE_OVER_PENALTY = -20;
const EXPERIENCE_BRACKET_BONUS = 6;
const ARRANGEMENT_REMOTE_BONUS = 5;
const ARRANGEMENT_ONSITE_PENALTY = -8;

export function fitAdjustment(
  job: RawJob,
  years: number = yearsOfExperience()
): { delta: number; reasons: string[] } {
  const reasons: string[] = [];
  let delta = 0;

  switch (job.geoEligibility) {
    case "restricted":
      delta += GEO_RESTRICTED_PENALTY;
      reasons.push(
        `not open to your location${
          job.geoRegions?.length ? ` (hiring in: ${job.geoRegions.join(", ")})` : ""
        }`
      );
      break;
    case "worldwide":
      delta += GEO_ELIGIBLE_BONUS;
      reasons.push("open worldwide - no location restriction");
      break;
    case "eligible":
      delta += GEO_ELIGIBLE_BONUS;
      reasons.push("open to your location");
      break;
    default:
      reasons.push("location eligibility not stated by this source");
  }

  if (job.minYears !== undefined) {
    if (job.minYears > years + EXPERIENCE_TOLERANCE_YEARS) {
      delta += EXPERIENCE_OVER_PENALTY;
      reasons.push(
        `wants ${job.minYears}+ years, you have ~${years.toFixed(1)} - likely filtered out`
      );
    } else if (job.maxYears !== undefined && job.minYears <= years && years <= job.maxYears) {
      delta += EXPERIENCE_BRACKET_BONUS;
      reasons.push(`asks for ${job.minYears}-${job.maxYears} years - you are in range`);
    }
  }

  switch (job.arrangement) {
    case "remote":
      delta += ARRANGEMENT_REMOTE_BONUS;
      reasons.push("remote");
      break;
    case "hybrid":
      delta += ARRANGEMENT_ONSITE_PENALTY;
      reasons.push("hybrid - requires office presence");
      break;
    case "onsite":
      delta += ARRANGEMENT_ONSITE_PENALTY;
      reasons.push("on-site - requires office presence");
      break;
    default:
      reasons.push("work arrangement not stated by this source");
  }

  return { delta, reasons };
}
```

In `scoreJob`, delete the old remote block (lines 271-284) and the `requiresTooManyYears` block (lines 293-296). Then replace the final `normalized` computation and return with:

```ts
  const normalized = Math.max(
    0,
    Math.min(
      100,
      Math.round((raw / Math.max(MAX_SKILL_WEIGHT * FULL_CREDIT_FRACTION, 1)) * 100)
    )
  );

  const fit = fitAdjustment(job);
  reasons.push(...fit.reasons);

  return { score: Math.max(0, Math.min(100, normalized + fit.delta)), reasons };
```

- [ ] **Step 5: Run the new test, then the whole suite**

Run: `npx vitest run tests/domain/scoring/fit.test.ts`
Expected: PASS

Run: `npm test`
Expected: PASS. `tests/domain/scoring/score.test.ts` will have cases asserting the old remote bonus wording ("NOT remote - lower priority", "remote status not stated by this source") and the 8-year penalty. Update those assertions to the new reason strings and the new adjustment magnitudes — the *behaviour* they guarded (remote is preferred; over-experienced roles are penalised) is preserved, only its expression changed. **Do not delete a test to make it pass.**

- [ ] **Step 6: Pass the new fields through the score stage**

In `lib/pipeline/stages/score.ts`, in the `scoreJob({...})` call, replace `remote: job.remote ?? true,` with:

```ts
        remote: job.remote ?? undefined,
        arrangement: (job.arrangement as RawJob["arrangement"]) ?? undefined,
        geoEligibility: (job.geoEligibility as RawJob["geoEligibility"]) ?? undefined,
        geoRegions: (job.geoRegions as string[]) ?? [],
        minYears: job.minYears ?? undefined,
        maxYears: job.maxYears ?? undefined,
        experienceText: job.experienceText ?? undefined,
        easyApply: job.easyApply ?? undefined,
```

and add `import type { RawJob } from "@/lib/domain/types";` at the top.

- [ ] **Step 7: Verify**

Run: `npm run verify`
Expected: clean

- [ ] **Step 8: Commit**

```bash
git add lib/domain/scoring/ lib/pipeline/stages/score.ts tests/domain/scoring/
git commit -m "feat: rank jobs by location eligibility, experience fit and arrangement"
```

---

### Task 9: Rewrite the LinkedIn card parser

**Depends on Task 1's fixture.** Do not start until `tests/fixtures/linkedin-alert.html` exists and Step 4 of Task 1 confirmed the card structure.

**Files:**
- Modify: `lib/infra/linkedin/alerts.ts:191-262` (`Parsed`, `parseAlertEmail`), `:147-152` (delete `inferRemote`), `:312-337` (the `RawJob` mapping)
- Test: `tests/infra/linkedin/alerts.test.ts` (extend)

**Interfaces:**
- Consumes: `deriveArrangement` (Task 3), `RawJob` fact fields (Task 6)
- Produces: `Parsed = { id, title, company, location?, arrangement, easyApply }`. `inferRemote` is removed; `tests/infra/linkedin/alerts.test.ts` imports it today and must be updated.

- [ ] **Step 1: Write the failing test**

```ts
// Append to tests/infra/linkedin/alerts.test.ts
import { readFileSync } from "node:fs";
import { parseAlertEmail } from "@/lib/infra/linkedin/alerts";

describe("parseAlertEmail against a real alert email", () => {
  const html = readFileSync("tests/fixtures/linkedin-alert.html", "utf8");
  const jobs = parseAlertEmail(html);

  it("finds several jobs", () => {
    expect(jobs.length).toBeGreaterThanOrEqual(3);
  });

  it("never returns a title containing the separator or a badge", () => {
    // The exact failure in production: the whole card became the title.
    for (const job of jobs) {
      expect(job.title).not.toContain("·");
      expect(job.title).not.toMatch(/easy apply|actively recruiting|applied on/i);
      expect(job.title.length).toBeLessThan(120);
    }
  });

  it("resolves a real company for most cards", () => {
    const known = jobs.filter((j) => j.company !== "Unknown");
    expect(known.length).toBeGreaterThan(jobs.length / 2);
  });

  it("classifies every card's arrangement", () => {
    for (const job of jobs) {
      expect(["remote", "hybrid", "onsite", "unknown"]).toContain(job.arrangement);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/infra/linkedin/alerts.test.ts`
Expected: FAIL — titles contain `·` and badge text

- [ ] **Step 3: Implement the card splitter**

In `lib/infra/linkedin/alerts.ts`, add above `parseAlertEmail`:

```ts
/** LinkedIn separates the title+company half of a card from the location half. */
const CARD_SEPARATOR = " · ";

/**
 * Trailing badges LinkedIn appends after the location.
 *
 * Anchored to the END of the string and stripped repeatedly, because a card
 * carries several ("... (On-site) Actively recruiting Easy Apply"). This is the
 * same enumeration problem as BADGE_LINE_PATTERNS and inherits its caveat: a
 * new badge wording will not be recognised and will remain glued to the
 * location, which degrades to a slightly wrong location rather than to a
 * mangled title.
 */
const TRAILING_BADGE_RES: readonly RegExp[] = [
  /\s+easy apply$/i,
  /\s+actively recruiting$/i,
  /\s+actively reviewing applicants$/i,
  /\s+be an early applicant$/i,
  /\s+fast growing$/i,
  /\s+promoted$/i,
  /\s+reposted$/i,
  /\s+verified$/i,
  /\s+viewed$/i,
  /\s+new$/i,
  /\s+applied on [a-z]{3}\s+\d{1,2}$/i,
  /\s+\d+\s+school alumni?$/i,
  /\s+\d[\d,.]*\+?\s+(connections?|alumni|applicants?|people)$/i,
  /\s+\d+\s+(minutes?|hours?|days?|weeks?|months?)\s+ago$/i,
];

const EASY_APPLY_RE = /\beasy apply\b/i;

export type CardParts = {
  /** Title and company, still joined — see splitCard's note. */
  head: string;
  location?: string;
  arrangement: WorkArrangement;
  easyApply: boolean;
};

/**
 * Splits one card's flattened text into its parts.
 *
 * The head is NOT split into title and company here, and cannot be: "SDE II HSV
 * Digital" has no rule that separates the role from the employer without a
 * company list. parseAlertEmail resolves the company from the card's company
 * ANCHOR instead, and subtracts it from the head. repairMangledCard (Task 10)
 * has no anchor available and so leaves the head whole.
 */
export function splitCard(raw: string): CardParts {
  const easyApply = EASY_APPLY_RE.test(raw);

  let text = raw.replace(/\s+/g, " ").trim();
  // Repeat until stable: a card carries several badges in sequence.
  for (let pass = 0; pass < TRAILING_BADGE_RES.length; pass++) {
    const before = text;
    for (const re of TRAILING_BADGE_RES) text = text.replace(re, "");
    if (text === before) break;
  }

  const at = text.indexOf(CARD_SEPARATOR);
  const head = (at >= 0 ? text.slice(0, at) : text).trim();
  const location = at >= 0 ? text.slice(at + CARD_SEPARATOR.length).trim() : undefined;

  return {
    head,
    location: location || undefined,
    arrangement: deriveArrangement({ location }),
    easyApply,
  };
}
```

Add the import at the top of the file:

```ts
import { deriveArrangement, type WorkArrangement } from "@/lib/domain/facts";
```

Delete `inferRemote`, `ONSITE_RE` and `REMOTE_RE` (lines 132-152) — `lib/domain/facts/arrangement.ts` owns that logic now.

- [ ] **Step 4: Rewrite `parseAlertEmail` to use it**

Replace the `Parsed` type and the body of `parseAlertEmail`:

```ts
export type Parsed = {
  id: string;
  title: string;
  company: string;
  location?: string;
  arrangement: WorkArrangement;
  easyApply: boolean;
};

/** The company name from the card's company link or logo, when present. */
function companyFromCard($: cheerio.CheerioAPI, container: unknown): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const $c = $(container as any);
  const linked = $c.find('a[href*="linkedin.com/company/"]').first().text().trim();
  if (linked) return linked.replace(/\s+/g, " ");
  const alt = $c.find("img[alt]").first().attr("alt")?.trim();
  // Logo alt text is often "CompanyName logo" or the job title; only accept it
  // when it is short and not obviously the title.
  if (alt && alt.length <= MAX_FIELD_LEN) return alt.replace(/\s+logo$/i, "").trim();
  return undefined;
}

export function parseAlertEmail(html: string): Parsed[] {
  const $ = cheerio.load(html);
  const byId = new Map<string, Parsed>();

  $("a[href]").each((_i, a) => {
    const href = $(a).attr("href") || "";
    const m = href.match(JOB_URL_RE);
    if (!m) return;
    const id = m[1];

    const raw = $(a).text().replace(/\s+/g, " ").trim();
    if (!raw || isNavigationText(raw)) return;

    const parts = splitCard(raw);
    if (!parts.head) return;

    const container = $(a).closest("td, tr, table").get(0);
    const company = container ? companyFromCard($, container) : undefined;

    // Subtract the company from the head to leave the title. LinkedIn writes
    // the card as "<Title> <Company>", so when the company is known the title
    // is simply the remainder.
    let title = parts.head;
    if (company && title.toLowerCase().endsWith(company.toLowerCase())) {
      title = title.slice(0, title.length - company.length).trim();
    }
    if (!title) title = parts.head;

    // Prefer the richest card seen for this id: LinkedIn emits several links
    // per job (logo, title, CTA) and only one carries the full card.
    const existing = byId.get(id);
    if (existing && existing.title.length >= title.length && existing.company !== "Unknown") {
      return;
    }

    byId.set(id, {
      id,
      title,
      company: company || "Unknown",
      location: parts.location,
      arrangement: parts.arrangement,
      easyApply: parts.easyApply,
    });
  });

  return [...byId.values()];
}
```

- [ ] **Step 5: Update the `RawJob` mapping in `fetchLinkedInAlerts`**

Replace the `remote: p.remote,` line and add the facts:

```ts
            location: p.location,
            arrangement: p.arrangement,
            easyApply: p.easyApply,
            remote:
              p.arrangement === "unknown" ? undefined : p.arrangement === "remote",
```

- [ ] **Step 6: Port the `inferRemote` tests to `deriveArrangement`**

`tests/infra/linkedin/alerts.test.ts` imports `inferRemote` on line 10 and exercises it in `describe("inferRemote")` at lines 341-364. Delete the import and replace that whole block with the equivalent four-state assertions — the cases are good and must not be lost, only re-expressed:

```ts
describe("deriveArrangement on LinkedIn location lines", () => {
  const at = (location?: string) => deriveArrangement({ location });

  it("reads remote", () => {
    expect(at("Remote, Worldwide")).toBe("remote");
    expect(at("Remote")).toBe("remote");
    expect(at("Austin, TX (Remote)")).toBe("remote");
    expect(at("Remote - United States")).toBe("remote");
    expect(at("Anywhere")).toBe("remote");
  });

  it("distinguishes on-site from hybrid instead of collapsing both to 'not remote'", () => {
    expect(at("Sydney, NSW (On-site)")).toBe("onsite");
    expect(at("Sydney, NSW (Onsite)")).toBe("onsite");
    expect(at("London, England, United Kingdom (Hybrid)")).toBe("hybrid");
    expect(at("Seattle, WA (Hybrid)")).toBe("hybrid");
    expect(at("Hybrid remote - Berlin")).toBe("hybrid");
  });

  it("is unknown when the line says nothing either way", () => {
    expect(at("Dublin, Ireland")).toBe("unknown");
    expect(at("London, England, United Kingdom")).toBe("unknown");
    expect(at("")).toBe("unknown");
    expect(at(undefined)).toBe("unknown");
  });
});
```

Add `import { deriveArrangement } from "@/lib/domain/facts";` at the top. Keep every other test in the file unchanged.

- [ ] **Step 7: Run the suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add lib/infra/linkedin/alerts.ts tests/infra/linkedin/alerts.test.ts
git commit -m "fix: parse LinkedIn's single-anchor card template"
```

---

### Task 10: Repair the 107 corrupt rows

**Files:**
- Modify: `lib/infra/linkedin/alerts.ts` (add `repairMangledCard`)
- Test: `tests/infra/linkedin/repair.test.ts`

**Interfaces:**
- Consumes: `splitCard` (Task 9)
- Produces: `repairMangledCard(storedTitle: string): { title: string; location?: string; arrangement: WorkArrangement; easyApply: boolean }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/infra/linkedin/repair.test.ts
import { describe, it, expect } from "vitest";
import { repairMangledCard } from "@/lib/infra/linkedin/alerts";

// Every input below is a verbatim `title` value from the production database.
describe("repairMangledCard", () => {
  it("recovers location, arrangement and easyApply from an on-site card", () => {
    expect(
      repairMangledCard(
        "Full Stack Developer SourceFuse · Mohali district (On-site) Actively recruiting Easy Apply"
      )
    ).toEqual({
      title: "Full Stack Developer SourceFuse",
      location: "Mohali district (On-site)",
      arrangement: "onsite",
      easyApply: true,
    });
  });

  it("recovers a hybrid card", () => {
    expect(
      repairMangledCard(
        "Senior Full-Stack GenAI Engineer Leapfrog Technology, Inc. · Pune/Pimpri-Chinchwad Area (Hybrid)"
      )
    ).toMatchObject({ arrangement: "hybrid", easyApply: false });
  });

  it("recovers a remote card", () => {
    expect(
      repairMangledCard("Node.JS Developer Concentrix · India (Remote) Easy Apply")
    ).toMatchObject({
      location: "India (Remote)",
      arrangement: "remote",
      easyApply: true,
    });
  });

  it("strips an 'Applied on' badge", () => {
    expect(
      repairMangledCard("SDE2 Curefit · Bengaluru, Karnataka, India Applied on Aug 7")
    ).toMatchObject({ location: "Bengaluru, Karnataka, India" });
  });

  it("strips a school-alumni badge", () => {
    expect(
      repairMangledCard("Software Engineer | AI Platforms SingleStore · Pune District (Hybrid) 1 school alum")
    ).toMatchObject({ location: "Pune District (Hybrid)", arrangement: "hybrid" });
  });

  it("strips a connections badge", () => {
    expect(
      repairMangledCard("GenAI – Software Engineer III Deloitte · Pune Division 2 connections")
    ).toMatchObject({ location: "Pune Division" });
  });

  // The critical regression: this card scored 0 because "recruiting" inside a
  // badge tripped the fatal role veto.
  it("removes the badge that was tripping the role veto", () => {
    const repaired = repairMangledCard(
      "AI Developer II OpenGov Inc. · Pune Division (On-site) Actively recruiting Fast growing"
    );
    expect(repaired.title).not.toMatch(/recruiting/i);
    expect(repaired.location).toBe("Pune Division (On-site)");
  });

  it("leaves a card with no separator whole rather than guessing", () => {
    expect(repairMangledCard("Some Unparseable Card")).toEqual({
      title: "Some Unparseable Card",
      location: undefined,
      arrangement: "unknown",
      easyApply: false,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/infra/linkedin/repair.test.ts`
Expected: FAIL — `repairMangledCard` is not exported

- [ ] **Step 3: Implement**

Append to `lib/infra/linkedin/alerts.ts`:

```ts
/**
 * Recovers what can be recovered from a title mangled by the previous parser.
 *
 * 107 rows in production stored an entire job card as their title — see the
 * note on parseAlertEmail. That string still contains the location, the work
 * arrangement and the Easy Apply badge, so the facts are recoverable without
 * going back to the mailbox (which no longer holds emails that old).
 *
 * What is NOT recoverable is the title/company split: the company anchor lived
 * in the HTML, not in this text, and "SDE II HSV Digital" cannot be divided by
 * rule. `title` is therefore returned as the badge-stripped head, still
 * containing the company name, and callers should leave `company` as "Unknown"
 * rather than invent one. lib/infra/linkedin/enrich.ts closes that gap from the
 * public job page's JSON-LD.
 */
export function repairMangledCard(storedTitle: string): {
  title: string;
  location?: string;
  arrangement: WorkArrangement;
  easyApply: boolean;
} {
  const parts = splitCard(storedTitle || "");
  return {
    title: parts.head,
    location: parts.location,
    arrangement: parts.arrangement,
    easyApply: parts.easyApply,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/infra/linkedin/repair.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add lib/infra/linkedin/alerts.ts tests/infra/linkedin/repair.test.ts
git commit -m "feat: recover facts from LinkedIn titles mangled by the old parser"
```

---

### Task 11: The backfill script

**Files:**
- Create: `scripts/backfill-facts.ts`
- Modify: `package.json` (add `db:backfill` script)

**Interfaces:**
- Consumes: `deriveJobFacts`, `FACTS_VERSION` (Task 5); `repairMangledCard` (Task 10); `scoreJob` (Task 8)
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Write the script**

```ts
// scripts/backfill-facts.ts
//
// Re-derives structured facts for stored jobs and re-scores them.
//
// Two jobs in one pass:
//   1. Repair linkedin_alert rows whose `title` is an entire mangled job card.
//   2. Derive facts for every row whose facts_version is below FACTS_VERSION,
//      then re-score it.
//
// Rows previously marked `rejected` are returned to the pipeline: many were
// rejected on a score computed from corrupt data, and leaving them rejected
// would make this fix invisible.
//
// Idempotent and safe to re-run: a row that already carries the current
// facts_version is skipped.
//
//   npm run db:backfill            (dry run - prints, changes nothing)
//   npm run db:backfill -- --write
import { eq, lt, or, isNull } from "drizzle-orm";
import { resolveDbTarget } from "./db-target";
import { deriveJobFacts, FACTS_VERSION } from "../lib/domain/facts";
import { repairMangledCard } from "../lib/infra/linkedin/alerts";
import { scoreJob } from "../lib/domain/scoring/score";
import type { RawJob } from "../lib/domain/types";

// MUST come before importing the db client: tsx does not load .env, and
// getDb() reads process.env at first call. Skipping this is the exact incident
// documented at the top of scripts/db-target.ts — the script reports success
// against the local SQLite fallback while the operator believes it wrote to
// Turso. resolveDbTarget() loads .env AND prints which database it resolved.
const target = resolveDbTarget();
console.log(`Backfilling ${target.label}`);

// Imported after the env is loaded, for the reason above.
const { getDb, schema } = await import("../lib/infra/db/client");

const WRITE = process.argv.includes("--write");

function tally<T extends string>(values: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

async function main() {
  const db = getDb();

  const rows = await db
    .select()
    .from(schema.jobs)
    .where(or(lt(schema.jobs.factsVersion, FACTS_VERSION), isNull(schema.jobs.factsVersion)));

  console.log(`${rows.length} rows below facts_version ${FACTS_VERSION}`);
  console.log("BEFORE arrangement:", tally(rows.map((r) => r.arrangement ?? "null")));

  let repaired = 0;
  let rescored = 0;
  const after: string[] = [];
  const geoAfter: string[] = [];

  for (const row of rows) {
    let title = row.title;
    let location = row.location ?? undefined;
    let arrangement: string | undefined;
    let easyApply: boolean | undefined;

    // A card that still contains the separator is a mangled title.
    if (row.source === "linkedin_alert" && row.title.includes(" · ")) {
      const fixed = repairMangledCard(row.title);
      title = fixed.title;
      location = fixed.location ?? location;
      arrangement = fixed.arrangement;
      easyApply = fixed.easyApply;
      repaired++;
    }

    const raw: RawJob = {
      source: row.source,
      sourceId: row.sourceId,
      title,
      company: row.company,
      url: row.url,
      location,
      tags: (row.tags as string[]) ?? [],
      description: row.description ?? undefined,
      remote: row.remote ?? undefined,
      arrangement: arrangement as RawJob["arrangement"],
      easyApply,
    };

    const facts = deriveJobFacts(raw);
    const scored = scoreJob({ ...raw, ...facts });

    after.push(facts.arrangement);
    geoAfter.push(facts.geoEligibility);

    if (WRITE) {
      await db
        .update(schema.jobs)
        .set({
          title,
          location,
          arrangement: facts.arrangement,
          geoEligibility: facts.geoEligibility,
          geoRegions: facts.geoRegions,
          minYears: facts.minYears,
          maxYears: facts.maxYears,
          experienceText: facts.experienceText,
          easyApply: facts.easyApply,
          factsVersion: FACTS_VERSION,
          remote:
            facts.arrangement === "unknown" ? null : facts.arrangement === "remote",
          score: scored.score,
          scoreReasons: scored.reasons,
          // A row rejected on a corrupt score deserves another pass. Rows the
          // operator has already acted on (sent, applied, responded) are left
          // exactly where they are.
          ...(row.status === "rejected" || row.status === "found"
            ? { status: "found" as const, stage: "score" as const, attempts: 0 }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.jobs.id, row.id));
    }
    rescored++;
  }

  console.log(`repaired ${repaired} mangled LinkedIn titles`);
  console.log(`re-scored ${rescored} rows`);
  console.log("AFTER arrangement:", tally(after));
  console.log("AFTER geo:", tally(geoAfter));
  if (!WRITE) console.log("\nDRY RUN - nothing written. Re-run with --write to apply.");
}

main().catch((err) => {
  console.error("BACKFILL FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
```

- [ ] **Step 2: Add the npm script**

In `package.json` `scripts`, after `db:reconcile`:

```json
    "db:backfill": "tsx scripts/backfill-facts.ts",
```

- [ ] **Step 3: Dry-run it and read the output**

Run: `npm run db:backfill`

Expected: a `BEFORE`/`AFTER` comparison. The `AFTER arrangement` tally must NOT be `{ remote: 623 }` — a believable spread with real `onsite` and `hybrid` counts is the whole point of this phase. If it is still all-remote, stop: something in Tasks 3, 5 or 7 is not wired up.

- [ ] **Step 4: Apply it**

Run: `npm run db:backfill -- --write`
Then re-run `npm run db:backfill` — it should report `0 rows below facts_version`, proving idempotence.

- [ ] **Step 5: Verify against the database directly**

```bash
node -e "
const fs=require('fs');
const env=Object.fromEntries(fs.readFileSync('.env','utf8').split(/\r?\n/).filter(l=>/^[A-Z_]+=/.test(l)).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1).trim()]}));
const {createClient}=require('@libsql/client');
const c=createClient({url:env.TURSO_DATABASE_URL,authToken:env.TURSO_AUTH_TOKEN});
(async()=>{
 for (const q of ['select arrangement, count(*) n from jobs group by arrangement',
                  'select geo_eligibility, count(*) n from jobs group by geo_eligibility',
                  'select count(*) n from jobs where easy_apply=1',
                  \"select title, company, location, arrangement, geo_eligibility, score from jobs where source='linkedin_alert' order by score desc limit 10\"]) {
   const r=await c.execute(q); console.log('\n'+q); console.table(r.rows);
 }
})()"
```

Expected: a real spread across arrangements, a non-zero `easy_apply` count, and LinkedIn rows with clean titles and non-zero scores.

- [ ] **Step 6: Commit**

```bash
git add scripts/backfill-facts.ts package.json
git commit -m "feat: add an idempotent facts backfill and re-score script"
```

---

### Task 12: Recover the company name from the public job page

Closes the one gap repair cannot: `company` stays `Unknown` on repaired rows. `parseJobPage()` already parses the page's JSON-LD, which carries `hiringOrganization.name`.

**Files:**
- Modify: `lib/infra/linkedin/enrich.ts:141-247` (`parseJobPage`, `EnrichResult`, `fetchJobDescription`)
- Modify: `lib/infra/db/schema.ts` (`linkedinEnrichCache` gains a `company` column)
- Modify: `lib/pipeline/stages/enrich.ts:140-180`
- Test: `tests/infra/linkedin/enrich.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new
- Produces: `parseJobPage(html) => { description?: string; company?: string }` — **a breaking change to an exported signature**; every caller in `enrich.ts` and `tests/infra/linkedin/enrich.test.ts` must be updated.

- [ ] **Step 1: Write the failing test**

```ts
// Append to tests/infra/linkedin/enrich.test.ts
describe("parseJobPage company recovery", () => {
  it("reads hiringOrganization.name from JSON-LD", () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      "@type": "JobPosting",
      title: "Full Stack Developer",
      description: "<p>Build things with React and TypeScript.</p>",
      hiringOrganization: { "@type": "Organization", name: "SourceFuse" },
    })}</script></head><body></body></html>`;
    const result = parseJobPage(html);
    expect(result.company).toBe("SourceFuse");
    expect(result.description).toContain("React");
  });

  it("returns an undefined company when JSON-LD omits it", () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      "@type": "JobPosting",
      description: "<p>Build things.</p>",
    })}</script></head><body></body></html>`;
    expect(parseJobPage(html).company).toBeUndefined();
  });

  it("returns an empty object for a page with nothing usable", () => {
    expect(parseJobPage("<html><body>nope</body></html>")).toEqual({
      description: undefined,
      company: undefined,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/infra/linkedin/enrich.test.ts`
Expected: FAIL — `parseJobPage` returns a string, so `.company` is undefined and the third case fails

- [ ] **Step 3: Change `parseJobPage` to return both fields**

Replace `jsonLdDescription` (lines 140-162) with a version that reads both fields off the same JobPosting node:

```ts
type JsonLdFacts = { description?: string; company?: string };

/**
 * Reads the description AND the hiring organisation from the page's JSON-LD.
 *
 * Both come off the same JobPosting node, so reading them together costs
 * nothing extra. The company matters because LinkedIn alert emails parsed by
 * the OLD parser stored "Unknown" — see repairMangledCard in ./alerts.ts, which
 * can recover a mangled card's location and arrangement from stored text but
 * provably cannot recover its employer.
 */
function jsonLdFacts($: cheerio.CheerioAPI): JsonLdFacts {
  for (const script of $('script[type="application/ld+json"]').toArray()) {
    const raw = $(script).text().trim();
    if (!raw) continue;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      // Truncated or non-JSON blocks are common; try the next one.
      continue;
    }
    const nodes: unknown[] = [];
    collectNodes(data, nodes);
    for (const node of nodes) {
      if (!isJobPosting(node)) continue;

      const org = (node as { hiringOrganization?: unknown }).hiringOrganization;
      const name =
        org && typeof org === "object"
          ? (org as { name?: unknown }).name
          : undefined;
      const company =
        typeof name === "string" && name.trim() ? name.trim() : undefined;

      const description = node.description;
      if (typeof description === "string" && description.trim()) {
        return { description, company };
      }
      // A node with a company but no description is still worth reporting:
      // the caller records not_found for the description and keeps the name.
      if (company) return { description: undefined, company };
    }
  }
  return {};
}
```

Then replace `parseJobPage` (lines 174-198) with:

```ts
export type ParsedJobPage = { description?: string; company?: string };

/**
 * Extracts the job description and hiring organisation from a job page.
 *
 * Prefers the JSON-LD JobPosting block: it is a published, structured contract
 * that changes far less often than LinkedIn's CSS class names. The class-name
 * selectors are only a fallback for pages that ship without it, and they carry
 * no company name — a page that falls through to them yields a description
 * alone.
 *
 * Returns undefined fields when the page carries neither (a removed listing, or
 * a page that wants a login) rather than guessing.
 */
export function parseJobPage(html: string): ParsedJobPage {
  if (!html || !html.trim()) return { description: undefined, company: undefined };

  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(html);
  } catch {
    return { description: undefined, company: undefined };
  }

  const fromJsonLd = jsonLdFacts($);
  if (fromJsonLd.description) {
    const text = toReadableText(fromJsonLd.description);
    if (text) return { description: text, company: fromJsonLd.company };
  }

  for (const selector of DESCRIPTION_SELECTORS) {
    const el = $(selector).first();
    if (!el.length) continue;
    const text = toReadableText(el.html() ?? "");
    if (text) return { description: text, company: fromJsonLd.company };
  }

  return { description: undefined, company: fromJsonLd.company };
}
```

- [ ] **Step 4: Thread it through `EnrichResult`, the cache and the stage**

Add `company` to `EnrichResult` (line 33-38):

```ts
export type EnrichResult = {
  jobId: string;
  description?: string;
  /** hiringOrganization.name from the page's JSON-LD, when it publishes one. */
  company?: string;
  outcome: EnrichOutcome;
  httpStatus?: number;
};
```

Replace lines 236-243 of `fetchJobDescription`:

```ts
    const { description, company } = parseJobPage(await res.text());
    if (!description) {
      // 200 but nothing readable: an expired listing or an auth wall. Saying
      // "not_found" is honest; the job stays title-only either way. The company
      // still rides along — it is useful even when the description is not there.
      return { jobId, company, outcome: "not_found", httpStatus };
    }

    return { jobId, description, company, outcome: "ok", httpStatus };
```

Add to `linkedinEnrichCache` in `lib/infra/db/schema.ts`:

```ts
  company: text("company"),
```

Run: `npm run db:generate && npx tsx scripts/migrate.ts`
Verify the generated SQL is a single `ALTER TABLE ... ADD COLUMN`, per the Global Constraints.

In `lib/pipeline/stages/enrich.ts`, cache the company (line 144-150 `.values({...})` gains `company: result.company,`), then give `advance()` a fourth argument. Replace lines 153-160:

```ts
      // Only offered when the stored company is the "Unknown" placeholder the
      // old alert parser wrote. A company a source stated correctly is never
      // overwritten by a scraped one.
      const recoveredCompany =
        result.company && job.company === "Unknown" ? result.company : undefined;

      if (result.outcome === "ok" && result.description) {
        ctx.counters.jobsEnriched++;
        await advance(ctx, job.id, result.description, "linkedin_public", recoveredCompany);
      } else {
        // Blocked, gone, or broken. Score it on the title and carry on; this is
        // a degraded result, not a failure worth retrying against a backoff.
        // A company may still have been recovered even with no description.
        await advance(ctx, job.id, undefined, undefined, recoveredCompany);
      }
```

and replace `advance` (lines 170-187):

```ts
async function advance(
  ctx: StageContext,
  jobId: number,
  description: string | undefined,
  descriptionSource: string | undefined,
  company?: string
) {
  await ctx.db
    .update(schema.jobs)
    .set({
      ...(description ? { description, descriptionSource } : {}),
      ...(company ? { company } : {}),
      stage: "score",
      attempts: 0,
      lastError: null,
      nextAttemptAt: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.jobs.id, jobId));
}
```

`job.company` is available here: `claimJobs` in `lib/pipeline/stages/claim.ts:33` uses a bare `.select()`, so it returns every column. No change needed there.

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: PASS. `tests/infra/linkedin/enrich.test.ts` has existing cases asserting `parseJobPage` returns a string; update them to read `.description`.

- [ ] **Step 6: Verify end to end**

Run: `npm run verify`
Expected: clean

- [ ] **Step 7: Commit**

```bash
git add lib/infra/linkedin/enrich.ts lib/infra/db/schema.ts lib/infra/db/migrations/ lib/pipeline/stages/enrich.ts tests/infra/linkedin/enrich.test.ts
git commit -m "feat: recover company names from the public LinkedIn page JSON-LD"
```

---

## Done criteria

- [ ] `npm run verify` is clean
- [ ] `select arrangement, count(*) from jobs group by arrangement` shows a real spread, not `{remote: 623}`
- [ ] `select geo_eligibility, count(*) from jobs group by geo_eligibility` shows a non-zero `restricted` bucket
- [ ] LinkedIn rows have titles under 120 characters and non-zero scores
- [ ] `select count(*) from jobs where easy_apply = 1` is non-zero
- [ ] `npm run db:backfill` reports `0 rows below facts_version` on a second run
- [ ] No `TODO`, `TBD` or commented-out code introduced
