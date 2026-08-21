import { CONTRACT_KEYWORDS } from "./taxonomy";
import {
  defaultProfile,
  yearsOfExperience,
  type ScoringProfile,
} from "./profile";
import { RawJob, RawLead } from "@/lib/domain/types";
import type { WorkArrangement } from "@/lib/domain/facts";

function haystack(...parts: (string | undefined | string[])[]): string {
  return parts
    .flat()
    .filter(Boolean)
    .join(" \n ")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Skill matching
//
// Skills match on whole tokens, never raw substrings. A plain `includes()`
// used to credit "ts" inside *agents* / *documents* / *clients*, "rag" inside
// *storage* / *leverage*, "git" inside *legitimate*, "ml" inside *html*, and
// "js" inside *jsx* - so a pure sales posting could reach the human-facing
// apply queue announcing that it "matches skill: typescript". Every one of
// those is a keystroke the user has to spend dismissing it, so the boundaries
// below are load-bearing, not cosmetic.
//
// `\b` is not used directly: several tokens start or end in punctuation
// ("next.js", "c++", ".net"), and `\b` on a punctuation edge asserts the
// opposite of what you want. The lookarounds are therefore applied only on the
// side where the token actually begins or ends with an alphanumeric.
// ---------------------------------------------------------------------------

const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

function tokenPattern(rawToken: string): RegExp {
  const token = rawToken.toLowerCase();
  const body = token.replace(REGEX_METACHARACTERS, "\\$&");
  // Underscores count as separators here (unlike `\b`), so snake_case tags
  // such as "node_js" still resolve to node.js and javascript.
  const left = /^[a-z0-9]/.test(token) ? "(?<![a-z0-9])" : "";
  // The optional trailing "s" lets a singular token match the plural the
  // posting actually wrote ("llm" -> "LLMs", "microservice" ->
  // "microservices") without reopening arbitrary substring matching.
  const right = /[a-z0-9]$/.test(token) ? "s?(?![a-z0-9])" : "";
  return new RegExp(left + body + right);
}

// ---------------------------------------------------------------------------
// Compiled profiles
//
// These used to be module-level constants built once at import, because there
// was one hardcoded resume and it could never change. Now every user brings
// their own profile, so the patterns have to be compiled per profile — and
// compiling ~50 regexes for every job in a 700-row list would be genuinely
// wasteful.
//
// A WeakMap keyed on the profile OBJECT is what makes that a non-issue: the
// jobs page builds one profile and scores every row against it, so compilation
// happens once per request and the entry is collected with the profile. No
// cache keys to invent, and — the part that matters — no way for an edited
// profile to keep scoring against its previous compilation, which any
// id-or-timestamp-keyed cache would have to get right by hand.
// ---------------------------------------------------------------------------

type CompiledProfile = {
  skills: { name: string; weight: number; patterns: RegExp[] }[];
  maxSkillWeight: number;
  targetRoleTokens: string[][];
  vetoes: { phrase: string; tokens: string[] }[];
  acceptedArrangements: WorkArrangement[];
  years: number | null;
};

const compiled = new WeakMap<ScoringProfile, CompiledProfile>();

function compileProfile(profile: ScoringProfile): CompiledProfile {
  const cached = compiled.get(profile);
  if (cached) return cached;

  const result: CompiledProfile = {
    skills: profile.skills.map((skill) => ({
      name: skill.name,
      weight: skill.weight,
      patterns: [skill.name, ...(skill.aliases || [])].map(tokenPattern),
    })),
    // Sum of every skill weight, accumulated once rather than inside the
    // scoring loop on every single job.
    maxSkillWeight: profile.skills.reduce((total, s) => total + s.weight, 0),
    targetRoleTokens: profile.targetRoles
      .map((role) => titleTokens(role.toLowerCase()).map(canonicalRoleToken))
      .filter((tokens) => tokens.length > 0),
    // Veto phrases are compared as raw tokens: none of them contains a role
    // noun, so canonicalisation would be a no-op and folding it in would only
    // blur the line between the policy list and the matching rules.
    vetoes: profile.vetoPhrases
      .map((phrase) => ({ phrase, tokens: titleTokens(phrase.toLowerCase()) }))
      .filter((veto) => veto.tokens.length > 0),
    acceptedArrangements: profile.acceptedArrangements,
    years: yearsOfExperience(profile.careerStart),
  };

  compiled.set(profile, result);
  return result;
}

// A posting only has to show this fraction of the total skill weight to earn
// full marks - no real job description lists a third of somebody's resume, so
// requiring 100% would squash every score into the bottom of the range.
//
// KNOWN CALIBRATION ISSUE, deliberately not tuned here: the flip side is that
// the top of the scale saturates. A strong-but-ordinary posting already lands
// in the 90s, so "good" and "outstanding" are hard to tell apart. The same
// caveat applies to the penalty magnitudes below - they are subtracted from
// `raw`, where -15 for an internship is worth roughly -43 points of the final
// 0-100 score. Retuning either one needs real outcome data (which postings the
// user actually applied to and heard back from), not a guess, and any change
// invalidates MATCH_THRESHOLD in lib/pipeline/stages/score.ts.
const FULL_CREDIT_FRACTION = 0.35;

// ---------------------------------------------------------------------------
// Target-role matching
//
// A title matches a target role when all of the role's word tokens appear in
// the title, in order, with any number of other words in between. Real titles
// interpose words constantly - "Node.js Backend Developer", "Senior React
// Frontend Developer", "Full Stack Engineer, Platform" - and the old
// `title.includes(role)` substring test threw the bonus away on every one of
// them. Missing a real target is the expensive direction of error here.
//
// Order still has to hold: "Developer Advocate for Node.js" is a different job
// from "Node.js Developer", and reversed tokens usually mean a different role.
//
// Tokens compare whole, so "dev" does not satisfy "developer" and "ops" does
// not satisfy "devops". `.`, `+` and `#` stay inside a token so "node.js",
// "next.js", "c++" and "c#" survive tokenisation; hyphens split, which is what
// lets "Front-End Developer" match the target "front end developer".
// ---------------------------------------------------------------------------

/**
 * Punctuation that starts a new clause. Without this, "Frontend Designer /
 * Sales Engineer" would let the target "frontend engineer" match straight
 * across the slash and claim a sales job as a target role.
 */
const TITLE_CLAUSE_SEPARATOR = /[\/|;,&()[\]{}•·–—]+/;

function titleClauses(title: string): string[] {
  // " - " is a clause break; an intra-word hyphen ("front-end") is not.
  return title
    .toLowerCase()
    .replace(/\s+-\s+/g, "|")
    .split(TITLE_CLAUSE_SEPARATOR);
}

function titleTokens(clause: string): string[] {
  return clause
    .split(/[^a-z0-9.+#]+/)
    // Strip a trailing sentence dot ("developer." -> "developer") without
    // touching a leading one (".net stays .net").
    .map((token) => token.replace(/\.+$/, ""))
    .filter(Boolean);
}

/**
 * "Engineer" and "developer" name the same job, and TARGET_ROLES only lists one
 * spelling of each pair ("next.js developer" but not "next.js engineer"), so
 * they are folded together before comparing. Without this, "Staff Next.js
 * Engineer" is discarded over a synonym.
 *
 * "engineering" is deliberately NOT folded in: keeping it distinct is what
 * stops "Software Engineering Manager" and "Director of AI Engineering" from
 * taking the bonus for a role Ribhu is not applying to.
 */
const ROLE_NOUN_SYNONYMS = new Map([["developer", "engineer"]]);

function canonicalRoleToken(token: string): string {
  return ROLE_NOUN_SYNONYMS.get(token) ?? token;
}

/** True when `needles` appears in `tokens` in order, gaps allowed. */
function containsInOrder(tokens: string[], needles: string[]): boolean {
  let matched = 0;
  for (const token of tokens) {
    if (token === needles[matched]) {
      matched += 1;
      if (matched === needles.length) return true;
    }
  }
  return false;
}

/** True when `phrase` appears in `tokens` as consecutive whole tokens. */
function containsAdjacent(tokens: string[], phrase: string[]): boolean {
  for (let start = 0; start + phrase.length <= tokens.length; start += 1) {
    if (phrase.every((token, offset) => tokens[start + offset] === token)) {
      return true;
    }
  }
  return false;
}

/**
 * The veto phrase disqualifying this title, or null.
 *
 * A veto anywhere in the title disqualifies the whole title, not just the
 * clause it sits in: "Frontend Engineer / Sales Manager" is still a job whose
 * other half is sales. Phrases are tested per clause only so that one cannot
 * be assembled across a separator ("... Business / Development Team").
 */
function vetoedRolePhrase(
  title: string,
  vetoes: CompiledProfile["vetoes"]
): string | null {
  const clauses = titleClauses(title).map(titleTokens);
  const hit = vetoes.find((veto) =>
    clauses.some((tokens) => containsAdjacent(tokens, veto.tokens))
  );
  return hit ? hit.phrase : null;
}

function matchesTargetRole(title: string, roleTokens: string[][]): boolean {
  return roleTokens.some((role) =>
    titleClauses(title).some((clause) =>
      containsInOrder(titleTokens(clause).map(canonicalRoleToken), role)
    )
  );
}

function roleVetoReason(phrase: string): string {
  return `title is a non-engineering role ("${phrase}") - excluded regardless of the skills below`;
}

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

/**
 * Arrangements the caller is treated as wanting when none is stated. Remote
 * rather than "all of them": this is a remote-jobs tool, and scoring the axis
 * neutrally would rank an on-site role in another city level with a remote one.
 */
const DEFAULT_ACCEPTED_ARRANGEMENTS: WorkArrangement[] = ["remote"];

const GEO_RESTRICTED_PENALTY = -25;
// +10, not +8: at +8 this exactly cancelled ARRANGEMENT_ONSITE_PENALTY
// (-8), so an India-eligible on-site job scored identically to a job where
// NEITHER axis was known - arrangement became a complete no-op for exactly
// the population (India-eligible postings) the operator cares most about.
// +10 breaks the cancellation while leaving every other constant, and the
// skill curve, untouched.
const GEO_ELIGIBLE_BONUS = 10;
const EXPERIENCE_OVER_PENALTY = -20;
const EXPERIENCE_BRACKET_BONUS = 6;
const ARRANGEMENT_REMOTE_BONUS = 5;
const ARRANGEMENT_ONSITE_PENALTY = -8;

/**
 * `years` may be null, meaning the profile does not know when this person's
 * career started. Every experience adjustment is then SKIPPED rather than
 * guessed: telling somebody a role "wants 8+ years, you have ~0" because their
 * resume did not parse is worse than saying nothing about experience at all.
 *
 * `accepted` is which arrangements the person will actually take. This is where
 * the removed filter chips went — expressed as a ranking input rather than a
 * hard filter, so an outstanding hybrid role can still out-rank a mediocre
 * remote one instead of being hidden outright.
 */
export function fitAdjustment(
  job: RawJob,
  years: number | null,
  accepted: WorkArrangement[] = DEFAULT_ACCEPTED_ARRANGEMENTS
): { delta: number; reasons: string[] } {
  const reasons: string[] = [];
  let delta = 0;
  const wanted = accepted.length ? accepted : DEFAULT_ACCEPTED_ARRANGEMENTS;

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

  if (job.minYears !== undefined && years !== null) {
    if (job.minYears > years + EXPERIENCE_TOLERANCE_YEARS) {
      delta += EXPERIENCE_OVER_PENALTY;
      reasons.push(
        `wants ${job.minYears}+ years, you have ~${years.toFixed(1)} - likely filtered out`
      );
    } else if (job.maxYears !== undefined && job.minYears <= years && years <= job.maxYears) {
      delta += EXPERIENCE_BRACKET_BONUS;
      reasons.push(`asks for ${job.minYears}-${job.maxYears} years - you are in range`);
    }
  } else if (job.minYears !== undefined) {
    reasons.push(
      `asks for ${job.minYears}+ years - add your career start date to your ` +
        `profile so this can be judged`
    );
  }

  if (job.arrangement === undefined || job.arrangement === "unknown") {
    reasons.push("work arrangement not stated by this source");
  } else if (wanted.includes(job.arrangement)) {
    delta += ARRANGEMENT_REMOTE_BONUS;
    reasons.push(job.arrangement);
  } else {
    delta += ARRANGEMENT_ONSITE_PENALTY;
    reasons.push(
      job.arrangement === "hybrid"
        ? "hybrid - requires office presence"
        : "on-site - requires office presence"
    );
  }

  return { delta, reasons };
}

/**
 * Scores a job 0-100 against Ribhu's resume skills + target roles.
 * Returns the score plus human-readable reasons (shown in the dashboard so
 * it's obvious *why* something ranked where it did, not a black box).
 *
 * One hard exclusion: a title naming a non-engineering role (see
 * ROLE_VETO_PHRASES) scores 0 regardless of its skill evidence.
 */
export function scoreJob(
  job: RawJob,
  profile: ScoringProfile = defaultProfile()
): { score: number; reasons: string[] } {
  const p = compileProfile(profile);
  const text = haystack(job.title, job.company, job.description, job.tags);
  const reasons: string[] = [];
  const vetoPhrase = vetoedRolePhrase(job.title || "", p.vetoes);
  let raw = 0;

  for (const skill of p.skills) {
    if (skill.patterns.some((p) => p.test(text))) {
      raw += skill.weight;
      reasons.push(`matches skill: ${skill.name}`);
    }
  }

  // Title/role bonus - 8 extra raw points if the title matches a role Ribhu is
  // actually targeting (prevents e.g. "React Native QA Tester" from
  // outscoring "Senior Next.js Engineer" purely on tag overlap).
  //
  // 8 raw is ~23 points of the final score: enough to lift a genuine target
  // over the bar alongside real skill evidence, but not enough to carry a
  // title-only match past MATCH_THRESHOLD on its own. That ceiling is what
  // makes the looser subsequence matching above safe.
  const title = (job.title || "").toLowerCase();
  if (!vetoPhrase && matchesTargetRole(title, p.targetRoleTokens)) {
    raw += 8;
    reasons.push("title matches a targeted role");
  }

  // Seniority guard: penalize roles that read as far too junior. The
  // complementary guard - an experience floor Ribhu cannot clear - is handled
  // below as a fit adjustment against job.minYears (see fitAdjustment), not by
  // re-parsing text here.
  if (/\b(intern|internship)\b/.test(title)) {
    raw -= 15;
    reasons.push("looks like an internship - deprioritized");
  }

  // `sparse` means we have a title but no description, so only skills visible
  // in the title can match and the score is structurally lower.
  //
  // This is no longer a property of the *source*. The enrich stage in
  // lib/pipeline/ recovers descriptions from the public job page for most
  // LinkedIn-alert jobs, so a job still flagged sparse by the time it reaches
  // scoring is one whose description genuinely could not be recovered - not
  // "this source never has descriptions".
  //
  // We do NOT inflate the number to compensate: the score stays an honest
  // reflection of the evidence, and deciding what to do with a low-confidence
  // score is the caller's job. (The dual-threshold scheme that once paired this
  // flag with its own lower cutoff has been removed; there is a single
  // MATCH_THRESHOLD in lib/pipeline/stages/score.ts. Do not reintroduce a
  // second threshold here.) We only prepend a reason so a reader of the
  // dashboard can see why the number is low.
  if (job.sparse) {
    reasons.unshift(
      "scored on title only - no job description could be recovered for this job"
    );
  }

  // Hard exclusion, applied last so the reasons above still show the evidence
  // that was genuinely present. 0 rather than a low cap: any cap is an
  // arbitrary number that has to be re-checked every time MATCH_THRESHOLD
  // moves, whereas 0 says "not a candidate" unambiguously and can never drift
  // back over a bar. The reasons list is what distinguishes this from a job
  // that simply had no evidence.
  if (vetoPhrase) {
    reasons.unshift(roleVetoReason(vetoPhrase));
    return { score: 0, reasons };
  }

  const normalized = Math.max(
    0,
    Math.min(
      100,
      Math.round((raw / Math.max(p.maxSkillWeight * FULL_CREDIT_FRACTION, 1)) * 100)
    )
  );

  const fit = fitAdjustment(job, p.years, p.acceptedArrangements);
  reasons.push(...fit.reasons);

  return { score: Math.max(0, Math.min(100, normalized + fit.delta)), reasons };
}

/**
 * Scores a freelance/contract lead 0-100. Leads are judged more loosely
 * since descriptions are often thin (RSS snippets).
 *
 * SCALE WARNING: this 0-100 is NOT the same scale as scoreJob's. Lead scores
 * are a flat 10 per matched keyword with no normalisation against a maximum,
 * so a lead on 60 and a job on 60 do not express comparable confidence and
 * MATCH_THRESHOLD does not mean the same thing for both. Never merge jobs and
 * leads into a single list ranked on this number. (Left as-is deliberately:
 * unifying the scales is a calibration change that needs outcome data.)
 */
export function scoreLead(lead: RawLead): { score: number; reasons: string[] } {
  const text = haystack(lead.title, lead.clientOrCompany, lead.description);
  const reasons: string[] = [];
  let raw = 0;

  for (const kw of CONTRACT_KEYWORDS) {
    if (text.includes(kw)) {
      raw += 10;
      reasons.push(`matches: ${kw}`);
    }
  }

  if (lead.budgetText) {
    reasons.push(`budget listed: ${lead.budgetText}`);
    raw += 5;
  }

  const normalized = Math.max(0, Math.min(100, raw));
  return { score: normalized, reasons };
}
