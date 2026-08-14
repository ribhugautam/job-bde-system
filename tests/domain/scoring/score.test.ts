import { describe, it, expect } from "vitest";
import { scoreJob, scoreLead } from "@/lib/domain/scoring/score";
import {
  SKILLS,
  CONTRACT_KEYWORDS,
  TARGET_ROLES,
  ROLE_VETO_PHRASES,
} from "@/lib/domain/scoring/resume-profile";
import type { RawJob, RawLead } from "@/lib/domain/types";

// ---------------------------------------------------------------------------
// Fixtures
//
// scoreJob's haystack is title + company + description + tags. `url`, `source`,
// `sourceId`, `location`, `salaryText` and `postedAt` are NOT scanned, so the
// defaults below are deliberately inert filler: no default field may contribute
// a skill match, or every test in this file would silently inherit points.
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<RawJob> = {}): RawJob {
  return {
    source: "test",
    sourceId: "job-1",
    title: "",
    company: "Acme",
    url: "https://example.invalid/job-1",
    ...overrides,
  };
}

function makeLead(overrides: Partial<RawLead> = {}): RawLead {
  return {
    source: "test",
    sourceId: "lead-1",
    title: "",
    url: "https://example.invalid/lead-1",
    ...overrides,
  };
}

/** A realistic senior full-stack posting: many resume skills, no penalties. */
const RICH_DESCRIPTION =
  "We need React, Next.js, TypeScript and Node.js experience. " +
  "You will build REST APIs backed by PostgreSQL and Docker.";

/** Every skill name and alias in the profile, i.e. the maximum possible evidence. */
const EVERY_SKILL_TOKEN = SKILLS.flatMap((s) => [
  s.name,
  ...(s.aliases ?? []),
]).join(" ");

const SPARSE_REASON =
  "scored on title only - no job description could be recovered for this job";
// The over-experience penalty now lives in fitAdjustment and is driven by the
// `minYears` fact rather than scoreJob parsing text itself (see
// lib/domain/facts/experience.ts for that extraction). Its reason string also
// embeds the candidate's actual years-of-experience figure, which changes as
// time passes, so it can no longer be asserted as a fixed string constant -
// tests match it with this regex instead.
const OVER_EXPERIENCED_REASON_RE =
  /^wants \d+\+ years, you have ~[\d.]+ - likely filtered out$/;
const UNSTATED_ARRANGEMENT_REASON = "work arrangement not stated by this source";
const ONSITE_REASON = "on-site - requires office presence";
const HYBRID_REASON = "hybrid - requires office presence";
const ROLE_REASON = "title matches a targeted role";

/** Did this title earn the target-role bonus? */
function matchedRole(title: string): boolean {
  return scoreJob(makeJob({ title })).reasons.includes(ROLE_REASON);
}

/** Did the over-experienced fit penalty fire? */
function hasOverExperiencedReason(reasons: string[]): boolean {
  return reasons.some((r) => OVER_EXPERIENCED_REASON_RE.test(r));
}

// ===========================================================================
// scoreJob
// ===========================================================================

describe("scoreJob", () => {
  describe("relative ranking", () => {
    it("ranks a strong match far above an unrelated job", () => {
      const strong = scoreJob(
        makeJob({
          title: "Senior Full Stack Engineer",
          description: RICH_DESCRIPTION,
          remote: true,
        })
      );
      const weak = scoreJob(
        makeJob({
          title: "Warehouse Operations Associate",
          company: "Acme Logistics",
          description: "Manage inventory and shipping schedules.",
        })
      );

      // Exact 0 is meaningful: a posting with zero resume evidence and zero
      // penalties must produce the floor, not a small positive "participation"
      // score. If this ever drifts above 0 the matcher has grown a bias.
      expect(weak.score).toBe(0);
      expect(strong.score).toBeGreaterThan(weak.score);
      // "materially higher", not a rounding artifact.
      expect(strong.score - weak.score).toBeGreaterThan(50);
    });

    it("ranks a job with more matching skills above one with fewer", () => {
      const many = scoreJob(
        makeJob({ title: "Software Engineer", description: RICH_DESCRIPTION })
      );
      const few = scoreJob(
        makeJob({ title: "Software Engineer", description: "We use React." })
      );

      expect(many.score).toBeGreaterThan(few.score);
      expect(many.reasons.length).toBeGreaterThan(few.reasons.length);
    });

    it("rewards a title that matches a targeted role", () => {
      const description = "React and TypeScript.";
      const targeted = scoreJob(
        makeJob({ title: "Frontend Engineer", description })
      );
      const untargeted = scoreJob(
        // Not on the veto list, so this isolates "no target role match".
        makeJob({ title: "Technical Copywriter", description })
      );

      expect(TARGET_ROLES).toContain("frontend engineer");
      expect(targeted.score).toBeGreaterThan(untargeted.score);
      expect(targeted.reasons).toContain("title matches a targeted role");
      expect(untargeted.reasons).not.toContain("title matches a targeted role");
    });

    it("matches a targeted role inside a longer title", () => {
      // Real postings are "Senior X, Platform Team", not the bare role name.
      const { reasons } = scoreJob(
        makeJob({ title: "Senior Full Stack Engineer, Platform Team" })
      );
      expect(reasons).toContain(ROLE_REASON);
    });

    it("reports each matched skill by its canonical name, not the alias hit", () => {
      // The description says "nextjs"/"reactjs"; the reason must name the skill.
      const { reasons } = scoreJob(
        makeJob({ title: "Engineer", description: "reactjs and nextjs shop" })
      );
      expect(reasons).toContain("matches skill: react");
      expect(reasons).toContain("matches skill: next.js");
    });

    it("scans tags and company, not just the description", () => {
      const viaTags = scoreJob(
        makeJob({ title: "Engineer", tags: ["flutter", "dart"] })
      );
      expect(viaTags.reasons).toContain("matches skill: flutter");
      expect(viaTags.reasons).toContain("matches skill: dart");
      expect(viaTags.score).toBeGreaterThan(0);
    });

    it("is deterministic", () => {
      const job = makeJob({
        title: "Senior Full Stack Engineer",
        description: RICH_DESCRIPTION,
        remote: true,
      });
      expect(scoreJob(job)).toEqual(scoreJob(job));
    });
  });

  describe("target role matching (ordered subsequence over word tokens)", () => {
    it.each([
      // The reported miss: a word interposed between the role's own tokens.
      "Node.js Backend Developer",
      "Senior Node.js Platform Developer",
      "Senior React Frontend Developer",
      "Staff Next.js Engineer",
      "Lead Flutter Mobile Developer",
      "Senior Software Product Engineer",
      "Full Stack Engineer, Platform",
      "Senior Full Stack Engineer (Next.js)",
      "Principal AI Platform Engineer",
      "Front-End Developer", // hyphen splits, so it reaches "front end developer"
      "Founding Engineer",
      "Senior LLM Infrastructure Engineer",
    ])("awards the role bonus to %j", (title) => {
      expect(matchedRole(title)).toBe(true);
    });

    it.each([
      // Order has to hold - these are genuinely different jobs.
      "Developer Advocate for Node.js",
      "Engineer Enablement Lead for Software",
      // No domain token from any target role.
      "Warehouse Operations Associate",
      "Cloud Storage Engineer",
      // (Sales/marketing titles are covered by the veto block below; these
      // cases must fail on role matching alone.)
      "Support Engineer",
      "Operations Manager",
      // "engineering" is not folded into "engineer" on purpose.
      "Software Engineering Manager",
      "Director of AI Engineering",
      // Whole-token comparison: abbreviations do not stand in for the word.
      "Senior Full Stack Dev",
      "DevOps Engineer",
    ])("withholds the role bonus from %j", (title) => {
      expect(matchedRole(title)).toBe(false);
    });

    it("requires order, not merely presence", () => {
      expect(matchedRole("Node.js Developer")).toBe(true);
      expect(matchedRole("Developer, Node.js")).toBe(false);
    });

    it("does not match across a clause separator", () => {
      // "frontend ... engineer" spans the slash here, but the two halves are
      // two different jobs and neither one is "frontend engineer".
      expect(matchedRole("Frontend Designer / Backend Engineer")).toBe(false);
      // ...while a target sitting wholly inside one clause still matches.
      expect(matchedRole("Frontend Engineer / Product Manager")).toBe(true);
    });

    it.each(["/", "|", ",", ";", "&", "–", "—", " - "])(
      "treats %j as a clause separator",
      (separator) => {
        expect(
          matchedRole(`Frontend Designer${separator}Backend Engineer`)
        ).toBe(false);
      }
    );

    it("treats engineer and developer as the same role noun", () => {
      // TARGET_ROLES lists "next.js developer" but not "next.js engineer";
      // a real posting is as likely to use either.
      expect(TARGET_ROLES).toContain("next.js developer");
      expect(TARGET_ROLES).not.toContain("next.js engineer");
      expect(matchedRole("Next.js Engineer")).toBe(true);
      expect(matchedRole("Next.js Developer")).toBe(true);
    });

    it("keeps punctuated tokens whole", () => {
      // "node.js" must be one token: if the dot split it, the stray "js" would
      // let unrelated titles satisfy part of the role.
      expect(matchedRole("Node.js Developer")).toBe(true);
      expect(matchedRole("Node Developer")).toBe(false);
      expect(matchedRole("JS Developer")).toBe(false);
    });

    it("is case insensitive", () => {
      expect(matchedRole("NODE.JS BACKEND DEVELOPER")).toBe(true);
      expect(matchedRole("node.js backend developer")).toBe(true);
    });

    it("tolerates a trailing period and extra whitespace", () => {
      expect(matchedRole("  Senior   Full  Stack   Engineer.  ")).toBe(true);
    });

    it("cannot carry a title-only match over MATCH_THRESHOLD by itself", () => {
      // The safety property that makes subsequence matching affordable: the
      // bonus is 8 raw (~23 points), so a title that matches a role but shows
      // no skill evidence still lands well under the pipeline's 40.
      const { score } = scoreJob(makeJob({ title: "Founding Engineer" }));
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThan(40);
    });

    it("still awards the bonus to every bare entry in TARGET_ROLES", () => {
      // The veto list must never suppress a role we are actually targeting.
      for (const role of TARGET_ROLES) {
        expect(matchedRole(role)).toBe(true);
      }
    });

    it("lifts a real target that the old substring test dropped", () => {
      const interposed = scoreJob(
        makeJob({ title: "Node.js Backend Developer", sparse: true })
      );
      const exact = scoreJob(
        makeJob({ title: "Node.js Developer", sparse: true })
      );
      // Same evidence, same score: the extra word is noise, not signal.
      expect(interposed.score).toBe(exact.score);
      expect(interposed.reasons).toContain(ROLE_REASON);
    });
  });

  describe("role veto list (policy, not matching)", () => {
    it.each([
      "Software Sales Engineer", // the reported regression
      "Senior Software Sales Engineer",
      "Sales Engineer",
      "Developer Marketing Manager",
      "Technical Recruiter for Software Engineers",
      "Recruiting Partner, Full Stack Engineering",
      "Account Executive, Software",
      "Business Development Manager, AI Engineering",
      "Customer Success Engineer",
      "Solutions Consultant, Full Stack",
    ])("withholds the role bonus from %j", (title) => {
      expect(matchedRole(title)).toBe(false);
    });

    it("vetoes the whole title, not just the clause the phrase sits in", () => {
      // The other half of the job is still sales.
      expect(matchedRole("Frontend Engineer / Product Manager")).toBe(true);
      expect(matchedRole("Frontend Engineer / Sales Manager")).toBe(false);
    });

    it("cannot assemble a veto phrase across a clause separator", () => {
      // "business" ends one clause and "development" starts the next, so a
      // naive flat scan of the title would read "business development" and
      // veto a genuine engineering role.
      expect(matchedRole("Software Engineer, Business / Development Team")).toBe(
        true
      );
    });

    it("matches veto phrases as whole adjacent tokens", () => {
      // Multi-word phrases must be consecutive...
      expect(matchedRole("Customer Success Engineer")).toBe(false);
      expect(matchedRole("Software Engineer, Customer Platform")).toBe(true);
      // ...and single tokens must not match inside longer words: Salesforce
      // engineering is engineering.
      expect(matchedRole("Salesforce Software Engineer")).toBe(true);
    });

    it("suppresses no entry in TARGET_ROLES", () => {
      // The direct form of the guarantee, independent of the matcher.
      for (const role of TARGET_ROLES) {
        for (const veto of ROLE_VETO_PHRASES) {
          expect(role).not.toContain(veto);
        }
      }
    });

    it("is fatal: a vetoed title scores exactly 0", () => {
      // Withholding the bonus was a no-op for these postings - they never
      // earned it. Exclusion has to be on the score itself.
      const { score } = scoreJob(
        makeJob({
          title: "Software Sales Engineer",
          description: "Demo our React and TypeScript product to prospects.",
          remote: true,
        })
      );
      expect(score).toBe(0);
    });

    it("cannot reach the bar however many skills the description lists", () => {
      // The adversarial case: every skill name and alias in the profile, in a
      // remote posting, in a title that also matches a target role. Skill
      // evidence must not be able to buy its way past a vetoed title.
      const stuffed = scoreJob(
        makeJob({
          title: "Technical Recruiter, Full Stack Engineer Hiring",
          description: EVERY_SKILL_TOKEN,
          tags: [EVERY_SKILL_TOKEN],
          remote: true,
        })
      );
      expect(stuffed.score).toBe(0);
      expect(stuffed.score).toBeLessThan(40);

      // ...and the identical description without the veto word saturates,
      // proving the 0 comes from the veto and not from a broken fixture.
      const control = scoreJob(
        makeJob({
          title: "Full Stack Engineer",
          description: EVERY_SKILL_TOKEN,
          tags: [EVERY_SKILL_TOKEN],
          remote: true,
        })
      );
      expect(control.score).toBe(100);
    });

    it.each(ROLE_VETO_PHRASES)(
      "scores 0 for a skill-stuffed posting titled with %j",
      (phrase) => {
        const { score } = scoreJob(
          makeJob({
            title: `Senior ${phrase} Engineer`,
            description: EVERY_SKILL_TOKEN,
            remote: true,
          })
        );
        expect(score).toBe(0);
      }
    );

    it("explains the zero and still shows the evidence that was there", () => {
      const { score, reasons } = scoreJob(
        makeJob({
          title: "Technical Recruiter",
          description: "Hiring React, TypeScript and Node.js engineers.",
          remote: true,
        })
      );

      expect(score).toBe(0);
      // The veto reason leads, so a dashboard reader sees why it is zero
      // before they see the skill list underneath.
      expect(reasons[0]).toBe(
        'title is a non-engineering role ("recruiter") - excluded regardless of the skills below'
      );
      // Skill evidence stays visible: the words really were in the posting.
      expect(reasons).toContain("matches skill: react");
      expect(reasons).toContain("matches skill: typescript");
      expect(reasons).toContain("matches skill: node.js");
      // ...but the role bonus is not claimed.
      expect(reasons).not.toContain(ROLE_REASON);
    });

    it("names the phrase that triggered the veto", () => {
      const { reasons } = scoreJob(
        makeJob({ title: "Account Executive, Software" })
      );
      expect(reasons[0]).toContain('"account executive"');
    });

    it("leads with the veto reason even on a sparse job", () => {
      const { reasons } = scoreJob(
        makeJob({ title: "Sales Engineer", sparse: true })
      );
      expect(reasons[0]).toContain("non-engineering role");
      expect(reasons[1]).toBe(SPARSE_REASON);
    });

    it("leaves engineering-adjacent roles alone", () => {
      // Explicitly NOT vetoed. Whether these are worth applying to is the
      // candidate's judgement call, not this module's, so they keep scoring on
      // their merits. Recorded as a known limitation, not an oversight.
      for (const title of [
        "Developer Advocate",
        "QA Engineer",
        "Technical Writer",
        "Product Manager, Developer Platform",
        "DevOps Engineer",
      ]) {
        const { score, reasons } = scoreJob(
          makeJob({
            title,
            description: "React, Next.js and TypeScript.",
            remote: true,
          })
        );
        expect(score).toBeGreaterThan(0);
        expect(reasons.some((r) => r.includes("non-engineering role"))).toBe(
          false
        );
      }
    });
  });

  describe("seniority penalties", () => {
    it("lowers the score for an internship and says why", () => {
      // Both ends chosen to sit strictly inside 0..100 so the penalty shows up
      // as a real delta rather than being swallowed by the clamp.
      const normal = scoreJob(
        makeJob({ title: "Full Stack Engineer", description: RICH_DESCRIPTION })
      );
      const intern = scoreJob(
        makeJob({
          title: "Full Stack Engineer Intern",
          description: RICH_DESCRIPTION,
        })
      );

      expect(normal.score).toBeGreaterThan(0);
      expect(normal.score).toBeLessThan(100);
      expect(intern.score).toBeGreaterThan(0);
      expect(intern.score).toBeLessThan(normal.score);
      expect(intern.reasons).toContain(
        "looks like an internship - deprioritized"
      );
      expect(normal.reasons).not.toContain(
        "looks like an internship - deprioritized"
      );
    });

    it.each(["Summer Intern", "Software Engineering Internship"])(
      "detects the internship keyword in %j",
      (title) => {
        expect(scoreJob(makeJob({ title })).reasons).toContain(
          "looks like an internship - deprioritized"
        );
      }
    );

    it("does not fire the internship penalty on substrings like 'internal'", () => {
      // The regex is word-bounded, which is what stops "Internal Tools
      // Engineer" from being written off as an internship.
      const { reasons } = scoreJob(makeJob({ title: "Internal Tools Engineer" }));
      expect(reasons).not.toContain("looks like an internship - deprioritized");
    });

    it("only reads the internship signal from the title, not the body", () => {
      // A senior role that merely mentions its internship programme keeps its
      // score. Deliberate: the title is the reliable signal.
      const { reasons } = scoreJob(
        makeJob({
          title: "Senior Software Engineer",
          description: "You will mentor our summer internship cohort.",
        })
      );
      expect(reasons).not.toContain("looks like an internship - deprioritized");
    });

    // Parsing "8+ years" / "10–15 years" / "at least 10 years" style phrases
    // out of a posting's prose is no longer scoreJob's job - that extraction
    // now lives in lib/domain/facts/experience.ts (deriveExperience), tested
    // in its own suite, and its result arrives here as the `minYears` /
    // `maxYears` facts. scoreJob's remaining responsibility is purely
    // numeric: given a stated floor, penalise it when it sits well above the
    // candidate's actual years (fitAdjustment's EXPERIENCE_TOLERANCE_YEARS).
    // The cases below are chosen far enough from the tolerance boundary that
    // they hold regardless of how the candidate's real years-of-experience
    // figure drifts with the calendar.
    it.each([10, 12, 15, 20, 50])(
      "fires the over-experienced penalty when the posting wants %i+ years",
      (minYears) => {
        const { reasons } = scoreJob(makeJob({ title: "Software Engineer", minYears }));
        expect(hasOverExperiencedReason(reasons)).toBe(true);
      }
    );

    it("states the floor the posting wants and the candidate's actual figure", () => {
      const { reasons } = scoreJob(makeJob({ title: "Engineer", minYears: 15 }));
      const hit = reasons.find((r) => OVER_EXPERIENCED_REASON_RE.test(r));
      expect(hit).toBeDefined();
      expect(hit).toContain("wants 15+ years");
    });

    it("lowers the score when the years penalty fires", () => {
      const base = scoreJob(
        makeJob({ title: "Full Stack Engineer", description: RICH_DESCRIPTION })
      );
      const senior = scoreJob(
        makeJob({
          title: "Full Stack Engineer",
          description: RICH_DESCRIPTION,
          minYears: 10,
        })
      );

      expect(senior.score).toBeGreaterThanOrEqual(0);
      expect(senior.score).toBeLessThan(base.score);
    });

    it("reads the experience floor from the minYears fact, not by re-parsing the description", () => {
      // Text alone, with the fact left unset, must do nothing: scoreJob
      // trusts the structured fact rather than hunting the description for a
      // number of its own.
      const { reasons } = scoreJob(
        makeJob({ title: "Engineer", description: "Must have 12+ years." })
      );
      expect(hasOverExperiencedReason(reasons)).toBe(false);
    });

    it.each([0, 1, 2])(
      "does NOT fire the over-experienced penalty when minYears is %i",
      (minYears) => {
        const { reasons } = scoreJob(makeJob({ title: "Software Engineer", minYears }));
        expect(hasOverExperiencedReason(reasons)).toBe(false);
      }
    );

    it("does not fire when no experience floor is stated at all", () => {
      const { reasons } = scoreJob(makeJob({ title: "Software Engineer" }));
      expect(hasOverExperiencedReason(reasons)).toBe(false);
    });

    it("rewards a range that brackets the candidate instead of penalising its floor", () => {
      // "1-10 years" is a wide net the candidate sits inside; "8-12" is not -
      // and because scoreJob is handed both ends of the range as facts (see
      // fitAdjustment), it can tell the two apart instead of only ever
      // looking at the lower bound the way the old text parser did.
      const insideRange = scoreJob(
        makeJob({ title: "Engineer", minYears: 1, maxYears: 10 })
      );
      const aboveRange = scoreJob(
        makeJob({ title: "Engineer", minYears: 8, maxYears: 12 })
      );
      expect(hasOverExperiencedReason(insideRange.reasons)).toBe(false);
      expect(
        insideRange.reasons.some((r) => r.includes("you are in range"))
      ).toBe(true);
      expect(hasOverExperiencedReason(aboveRange.reasons)).toBe(true);
    });

    it("trusts the minYears fact as given, without re-deriving a different figure from the text", () => {
      // The description mentions a higher floor than the fact does; scoreJob
      // must not second-guess the fact by re-scanning the text. Reconciling
      // multiple stated floors into one winning figure already happens
      // upstream, in deriveExperience, before scoreJob ever runs.
      const { reasons } = scoreJob(
        makeJob({
          title: "Engineer",
          description: "3+ years with React. 10+ years overall.",
          minYears: 3,
        })
      );
      expect(hasOverExperiencedReason(reasons)).toBe(false);
    });

    it("is deterministic across repeated calls with the same facts", () => {
      const job = makeJob({ title: "Engineer", minYears: 10 });
      const first = scoreJob(job);
      const second = scoreJob(job);
      const third = scoreJob(job);
      expect(first).toEqual(second);
      expect(second).toEqual(third);
      expect(hasOverExperiencedReason(first.reasons)).toBe(true);
    });
  });

  describe("work arrangement fit", () => {
    it("scores remote above on-site and explains both", () => {
      const remote = scoreJob(
        makeJob({
          title: "Full Stack Engineer",
          description: RICH_DESCRIPTION,
          arrangement: "remote",
        })
      );
      const onsite = scoreJob(
        makeJob({
          title: "Full Stack Engineer",
          description: RICH_DESCRIPTION,
          arrangement: "onsite",
        })
      );

      expect(remote.score).toBeGreaterThan(onsite.score);
      expect(remote.reasons).toContain("remote");
      expect(remote.reasons).not.toContain(ONSITE_REASON);
      expect(onsite.reasons).toContain(ONSITE_REASON);
      expect(onsite.reasons).not.toContain("remote");
    });

    it("penalises hybrid the same as on-site, since both require office presence", () => {
      const hybrid = scoreJob(
        makeJob({
          title: "Full Stack Engineer",
          description: RICH_DESCRIPTION,
          arrangement: "hybrid",
        })
      );
      const onsite = scoreJob(
        makeJob({
          title: "Full Stack Engineer",
          description: RICH_DESCRIPTION,
          arrangement: "onsite",
        })
      );
      expect(hybrid.reasons).toContain(HYBRID_REASON);
      expect(hybrid.score).toBe(onsite.score);
    });

    it("treats an unstated arrangement as unknown, not as on-site", () => {
      // Four distinct states. Unknown must not inherit the on-site reason:
      // that is a claim about the posting the source never made.
      const unknown = scoreJob(
        makeJob({ title: "Full Stack Engineer", description: RICH_DESCRIPTION })
      );
      expect(unknown.reasons).toContain(UNSTATED_ARRANGEMENT_REASON);
      expect(unknown.reasons).not.toContain(ONSITE_REASON);
      expect(unknown.reasons).not.toContain("remote");
    });

    it("neither rewards nor punishes an unstated arrangement, but still ranks below remote and above on-site", () => {
      const base = { title: "Full Stack Engineer", description: RICH_DESCRIPTION };
      const unknown = scoreJob(makeJob(base));
      const onsite = scoreJob(makeJob({ ...base, arrangement: "onsite" }));
      const remote = scoreJob(makeJob({ ...base, arrangement: "remote" }));

      // Unlike the old boolean `remote` flag - where unknown collapsed onto
      // on-site's score because neither got a bonus - arrangement now carries
      // an explicit on-site *penalty* (see ARRANGEMENT_ONSITE_PENALTY), so
      // unknown's zero delta sits strictly between the two instead of tying
      // with either one. Absence of evidence still must not be scored as
      // evidence either way.
      expect(unknown.score).toBeGreaterThan(onsite.score);
      expect(unknown.score).toBeLessThan(remote.score);
    });

    it("gives every job exactly one arrangement reason", () => {
      const variants = [undefined, "remote", "hybrid", "onsite", "unknown"] as const;
      for (const arrangement of variants) {
        const { reasons } = scoreJob(makeJob({ title: "Engineer", arrangement }));
        const arrangementReasons = reasons.filter(
          (r) =>
            r === "remote" ||
            r === ONSITE_REASON ||
            r === HYBRID_REASON ||
            r === UNSTATED_ARRANGEMENT_REASON
        );
        expect(arrangementReasons).toHaveLength(1);
      }
    });
  });

  describe("sparse jobs", () => {
    const sparseJob = makeJob({ title: "React Developer", sparse: true });
    const sameJobNotSparse = makeJob({ title: "React Developer" });

    it("prepends the explanatory reason ahead of the evidence", () => {
      const { reasons } = scoreJob(sparseJob);
      // Position matters: the caveat has to be the first thing a dashboard
      // reader sees, before the (few) title-only matches that follow.
      expect(reasons[0]).toBe(SPARSE_REASON);
      expect(reasons.slice(1)).toContain("matches skill: react");
    });

    it("does not add the reason for a normal job", () => {
      expect(scoreJob(sameJobNotSparse).reasons).not.toContain(SPARSE_REASON);
    });

    it("does not inflate or deflate the number", () => {
      // The honesty property the module is built around: `sparse` annotates the
      // score, it never adjusts it. Thresholding is the caller's decision, so
      // the flag must not smuggle a compensation factor into the value.
      expect(scoreJob(sparseJob).score).toBe(scoreJob(sameJobNotSparse).score);
    });

    it("still scores title-only evidence honestly (below a full-text match)", () => {
      const titleOnly = scoreJob(sparseJob);
      const fullText = scoreJob(
        makeJob({ title: "React Developer", description: RICH_DESCRIPTION })
      );
      expect(titleOnly.score).toBeGreaterThan(0);
      expect(titleOnly.score).toBeLessThan(fullText.score);
    });

    it("keeps the caveat first even when penalties also apply", () => {
      const { reasons } = scoreJob(
        makeJob({ title: "Software Engineer Intern", sparse: true })
      );
      expect(reasons[0]).toBe(SPARSE_REASON);
      expect(reasons).toContain("looks like an internship - deprioritized");
    });
  });

  describe("clamping to 0..100", () => {
    it("caps a keyword-stuffed description at exactly 100", () => {
      // Adversarial: every skill name AND every alias in one blob. 100 is the
      // documented ceiling of the scale, so the exact value is the assertion.
      const { score } = scoreJob(
        makeJob({
          title: "Full Stack Engineer",
          description: EVERY_SKILL_TOKEN,
          remote: true,
          tags: [EVERY_SKILL_TOKEN],
        })
      );
      expect(score).toBe(100);
      expect(score).toBeLessThanOrEqual(100);
    });

    it("stays at or below 100 when stuffing is combined with penalties", () => {
      const { score, reasons } = scoreJob(
        makeJob({
          title: "Full Stack Engineer Intern",
          description: EVERY_SKILL_TOKEN,
          arrangement: "remote",
          minYears: 10,
        })
      );
      expect(score).toBeLessThanOrEqual(100);
      expect(score).toBeGreaterThanOrEqual(0);
      // Penalties are recorded even when the raw total is far past the ceiling,
      // so the reasons stay truthful about what was detected.
      expect(reasons).toContain("looks like an internship - deprioritized");
      expect(hasOverExperiencedReason(reasons)).toBe(true);
    });

    it("floors an empty job at exactly 0", () => {
      // The other end of the documented scale.
      expect(scoreJob(makeJob()).score).toBe(0);
    });

    it("floors a garbage job at exactly 0 instead of going negative", () => {
      // Raw total here is deeply negative (-25 before normalisation); the clamp
      // is the only thing keeping the contract.
      const { score } = scoreJob(
        makeJob({
          // Not vetoed, so the 0 has to come from the clamp, not the veto.
          title: "Warehouse Intern",
          company: "",
          description: "Requires 10+ years of unrelated experience.",
        })
      );
      expect(score).toBe(0);
      expect(score).toBeGreaterThanOrEqual(0);
    });

    it("keeps every score an integer inside 0..100", () => {
      const cases: RawJob[] = [
        makeJob(),
        makeJob({ title: "", company: "", description: "" }),
        makeJob({ title: "!!! ??? ***", description: "\n\t  " }),
        makeJob({ title: "React Developer", sparse: true }),
        makeJob({ title: "Warehouse Intern", description: "10+ years" }),
        makeJob({ description: EVERY_SKILL_TOKEN, remote: true }),
        makeJob({
          title: "Full Stack Engineer Intern",
          description: EVERY_SKILL_TOKEN.repeat(3),
          tags: [EVERY_SKILL_TOKEN],
          remote: true,
        }),
        makeJob({ title: "Senior Full Stack Engineer", description: RICH_DESCRIPTION }),
      ];

      for (const job of cases) {
        const { score } = scoreJob(job);
        expect(Number.isInteger(score)).toBe(true);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(100);
      }
    });

    it("does not double-count a skill repeated many times", () => {
      const once = scoreJob(makeJob({ title: "Engineer", description: "react" }));
      const spammed = scoreJob(
        makeJob({ title: "Engineer", description: "react ".repeat(200) })
      );
      expect(spammed.score).toBe(once.score);
      expect(spammed.reasons).toEqual(once.reasons);
    });
  });

  describe("whole-token skill matching (no substring false positives)", () => {
    // Regression suite for the defect that let a sales posting reach the
    // human-facing apply queue claiming it matched typescript/rag/git. Skills
    // now match on token boundaries, so a short alias cannot hide inside a
    // longer unrelated word.
    it("scores the sales posting that used to claim three skill matches at zero", () => {
      const { score, reasons } = scoreJob(
        makeJob({
          // Deliberately not a vetoed title: the 0 must come from the token
          // boundaries finding no skills, not from the veto short-circuit.
          title: "Senior Operations Agents Manager",
          company: "Acme",
          description: "Manage storage of legitimate documents for clients.",
        })
      );

      expect(reasons).not.toContain("matches skill: typescript");
      expect(reasons).not.toContain("matches skill: rag");
      expect(reasons).not.toContain("matches skill: git");
      expect(reasons.filter((r) => r.startsWith("matches skill:"))).toEqual([]);
      // Exact 0: this posting contains no resume evidence whatsoever, so it
      // must sit on the floor rather than anywhere near MATCH_THRESHOLD.
      expect(score).toBe(0);
    });

    it.each([
      ["agents", "typescript"], // "ts"
      ["documents", "typescript"],
      ["clients", "typescript"],
      ["consultants", "typescript"],
      ["storage", "rag"],
      ["leverage", "rag"],
      ["legitimate", "git"],
      ["digital", "git"],
      ["html", "machine learning"], // "ml"
      ["xml", "machine learning"],
      ["jsx", "javascript"], // "js"
      ["internals", "iis"], // "iis" inside a longer word
      ["postgresql", "sql"], // has its own entry; see below
      ["anode", "node.js"], // "node"
    ])("does not credit %j as a match for %j", (word, skill) => {
      const { reasons } = scoreJob(
        makeJob({ title: "Operations Manager", description: `We handle ${word}.` })
      );
      expect(reasons).not.toContain(`matches skill: ${skill}`);
    });

    it.each([
      ["We build with React.", "react"],
      ["A Next.js codebase.", "next.js"],
      ["Node.js services.", "node.js"],
      ["Strong React/TS skills.", "typescript"], // bare "ts" as a real token
      ["Heavy node_js tooling.", "node.js"], // underscore is a separator
      ["We run reactjs and nextjs.", "react"],
      ["Experience with multi-agent systems.", "multi-agent"], // hyphenated
      ["Deep RAG experience.", "rag"],
      ["Serving LLMs in production.", "llm"], // plural of a 3-letter token
      ["We build AI agents.", "agentic ai"],
      ["Designing REST APIs.", "rest api"],
      ["A microservices estate.", "microservices"],
      ["Third-party API integrations.", "api integration"],
      ["Tailwind CSS everywhere.", "tailwind"],
      ["We use MySQL.", "sql"], // aliased on purpose, see resume-profile.ts
    ])("still credits %j as a match for %j", (description, skill) => {
      const { reasons } = scoreJob(makeJob({ title: "Engineer", description }));
      expect(reasons).toContain(`matches skill: ${skill}`);
    });

    it("accepts a plural, and eats the collision that comes with it", () => {
      // The optional trailing "s" is what makes "LLMs", "AI agents" and
      // "microservices" land, which matters far more than the cost: a short
      // skill token whose English plural is an unrelated word will still
      // collide. "darts" credits Dart. That is a knowingly accepted trade,
      // not an oversight - it needs a posting about darts to bite.
      expect(
        scoreJob(makeJob({ title: "Engineer", description: "llms" })).reasons
      ).toContain("matches skill: llm");
      expect(
        scoreJob(makeJob({ title: "Engineer", description: "darts night" }))
          .reasons
      ).toContain("matches skill: dart");
    });

    it("credits postgres once, not twice", () => {
      // "postgresql" contains "sql", but postgresql is its own weighted skill,
      // so crediting both would count one piece of evidence twice. Documented
      // decision in resume-profile.ts: postgresql is NOT an alias of sql.
      const { reasons } = scoreJob(
        makeJob({ title: "Engineer", description: "We run PostgreSQL 16." })
      );
      expect(reasons).toContain("matches skill: postgresql");
      expect(reasons).not.toContain("matches skill: sql");
    });

    it("handles tokens containing regex metacharacters literally", () => {
      // "next.js" must be a literal dot, not "any character": if the pattern
      // were unescaped, "nextxjs" would match.
      const literal = scoreJob(
        makeJob({ title: "Engineer", description: "next.js" })
      );
      const decoy = scoreJob(
        makeJob({ title: "Engineer", description: "nextxjs" })
      );
      expect(literal.reasons).toContain("matches skill: next.js");
      expect(decoy.reasons).not.toContain("matches skill: next.js");
    });

    it("matches a token sitting against punctuation and at string edges", () => {
      for (const description of [
        "react",
        "react.",
        "(react)",
        "react, next.js, and typescript",
        "stack: react/next.js",
        "[react]",
      ]) {
        expect(
          scoreJob(makeJob({ title: "Engineer", description })).reasons
        ).toContain("matches skill: react");
      }
    });

    it("is case insensitive across boundaries", () => {
      const upper = scoreJob(
        makeJob({ title: "Engineer", description: "REACT, NEXT.JS, LLMS" })
      );
      const lower = scoreJob(
        makeJob({ title: "Engineer", description: "react, next.js, llms" })
      );
      expect(upper.score).toBe(lower.score);
      expect(upper.reasons).toEqual(lower.reasons);
      expect(upper.score).toBeGreaterThan(0);
    });
  });

  describe("known calibration issues (documented, deliberately not tuned)", () => {
    // Recorded here so the next reader hits them with evidence instead of
    // rediscovering them. Fixing either needs real outcome data, and either
    // change invalidates MATCH_THRESHOLD in lib/pipeline/stages/score.ts.
    it("saturates near the top of the scale on an ordinary strong posting", () => {
      // Full credit is 35% of total skill weight, so a plainly good - not
      // exceptional - posting already lands in the high 80s on skill evidence
      // alone, and a stated remote arrangement (+5, applied to the
      // normalised score - see fitAdjustment) pushes it further still. There
      // is very little room left to distinguish "good" from "outstanding".
      const { score } = scoreJob(
        makeJob({
          title: "Senior Full Stack Engineer",
          description: RICH_DESCRIPTION,
          arrangement: "remote",
        })
      );
      expect(score).toBeGreaterThanOrEqual(85);
      expect(score).toBeLessThanOrEqual(100);
    });

    it("applies penalties that are large once normalised", () => {
      // -15 raw for an internship is worth roughly -43 points of the final
      // score, enough to drive a mid-tier posting to the floor on the title
      // alone.
      const normal = scoreJob(
        makeJob({ title: "Software Engineer", description: "React and TypeScript." })
      );
      const intern = scoreJob(
        makeJob({
          title: "Software Engineer Intern",
          description: "React and TypeScript.",
        })
      );
      expect(normal.score).toBeGreaterThan(35);
      expect(intern.score).toBe(0);
    });
  });
});

// ===========================================================================
// scoreLead
// ===========================================================================

describe("scoreLead", () => {
  it("awards exactly 10 for a single contract keyword", () => {
    // 10 per keyword is the whole lead-scoring rule, so the exact number is the
    // behaviour under test. "flutter" is the only CONTRACT_KEYWORD present.
    const { score, reasons } = scoreLead(
      makeLead({
        title: "Flutter developer needed",
        description: "Build a mobile app.",
      })
    );
    expect(score).toBe(10);
    expect(reasons).toEqual(["matches: flutter"]);
  });

  it("scales with the number of distinct keywords matched", () => {
    const one = scoreLead(makeLead({ title: "Need a chatbot" }));
    const two = scoreLead(makeLead({ title: "Need a chatbot with RAG" }));
    const three = scoreLead(
      makeLead({ title: "Need a chatbot with RAG", description: "React UI." })
    );

    expect(two.score).toBeGreaterThan(one.score);
    expect(three.score).toBeGreaterThan(two.score);
    // Each additional keyword contributes a fixed 10 points.
    expect(two.score - one.score).toBe(10);
    expect(three.score - two.score).toBe(10);
  });

  it("adds exactly 5 for a listed budget and quotes it in the reasons", () => {
    const noBudget = scoreLead(
      makeLead({ title: "Flutter developer needed", description: "Mobile app." })
    );
    const withBudget = scoreLead(
      makeLead({
        title: "Flutter developer needed",
        description: "Mobile app.",
        budgetText: "$3,000 - $5,000",
      })
    );

    // The budget bonus is a flat 5 - smaller than a keyword hit on purpose,
    // since a stated budget is a weaker signal than a skill match.
    expect(withBudget.score - noBudget.score).toBe(5);
    expect(withBudget.reasons).toContain("budget listed: $3,000 - $5,000");
    expect(noBudget.reasons.some((r) => r.startsWith("budget listed"))).toBe(
      false
    );
  });

  it("does not mine the budget text for keywords", () => {
    // budgetText is outside the haystack; only its presence counts. Otherwise a
    // budget line quoting a stack would double-count as skill evidence.
    const { score, reasons } = scoreLead(
      makeLead({
        title: "Flutter developer needed",
        description: "Mobile app.",
        budgetText: "react next.js llm rag typescript",
      })
    );
    expect(score).toBe(15); // one keyword (10) + budget present (5)
    expect(reasons).toHaveLength(2);
  });

  it("scans the client name as well as title and description", () => {
    const { reasons } = scoreLead(
      makeLead({ title: "Contract role", clientOrCompany: "Flutter Labs" })
    );
    expect(reasons).toContain("matches: flutter");
  });

  it("clamps a keyword-stuffed lead to exactly 100", () => {
    // Raw total here is 13 keywords x 10 + 5 = 135; 100 is the documented cap.
    const { score } = scoreLead(
      makeLead({
        title: "Everything",
        description: CONTRACT_KEYWORDS.join(" "),
        budgetText: "open",
      })
    );
    expect(score).toBe(100);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("floors an empty lead at exactly 0 with no reasons", () => {
    const { score, reasons } = scoreLead(makeLead());
    expect(score).toBe(0);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(reasons).toEqual([]);
  });

  it("keeps every lead score an integer inside 0..100", () => {
    const cases: RawLead[] = [
      makeLead(),
      makeLead({ title: "!!! ???" }),
      makeLead({ title: "React", budgetText: "" }), // empty budget is falsy: no bonus
      makeLead({ description: CONTRACT_KEYWORDS.join(" ").repeat(5) }),
      makeLead({
        title: CONTRACT_KEYWORDS.join(" "),
        clientOrCompany: CONTRACT_KEYWORDS.join(" "),
        description: CONTRACT_KEYWORDS.join(" "),
        budgetText: "$$$",
      }),
    ];

    for (const lead of cases) {
      const { score } = scoreLead(lead);
      expect(Number.isInteger(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });

  it("treats an empty budget string as no budget", () => {
    const { reasons } = scoreLead(makeLead({ title: "React", budgetText: "" }));
    expect(reasons.some((r) => r.startsWith("budget listed"))).toBe(false);
  });

  it("is case insensitive", () => {
    const upper = scoreLead(makeLead({ title: "FLUTTER AND LLM WORK" }));
    const lower = scoreLead(makeLead({ title: "flutter and llm work" }));
    expect(upper.score).toBe(lower.score);
    expect(upper.score).toBeGreaterThan(0);
  });
});
