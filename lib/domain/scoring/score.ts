import {
  SKILLS,
  TARGET_ROLES,
  CONTRACT_KEYWORDS,
  ROLE_VETO_PHRASES,
} from "./resume-profile";
import { RawJob, RawLead } from "@/lib/domain/types";

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

// Patterns are compiled once at module load rather than per scored job.
const SKILL_MATCHERS = SKILLS.map((skill) => ({
  name: skill.name,
  weight: skill.weight,
  patterns: [skill.name, ...(skill.aliases || [])].map(tokenPattern),
}));

// Sum of every skill weight. It depends only on the resume profile, so it is
// computed once here instead of being re-accumulated inside the scoring loop
// on every single job.
const MAX_SKILL_WEIGHT = SKILLS.reduce((total, skill) => total + skill.weight, 0);

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
// Seniority guard
// ---------------------------------------------------------------------------

/** Ribhu has ~3 years, so a hard floor at or above this is a filter he fails. */
const OVER_EXPERIENCED_YEARS = 8;

const OVER_EXPERIENCED_REASON = `requires ${OVER_EXPERIENCED_YEARS}+ years experience - likely mismatch`;

// The shapes a years-of-experience *requirement* actually takes in postings.
// Each pattern captures the number that represents the floor, which is then
// compared against OVER_EXPERIENCED_YEARS - so "2+ years" and "3-5 years" are
// matched and then correctly ignored rather than being absent from the regex.
//
// A bare "10 years" is deliberately NOT a requirement: "founded 10 years ago"
// and "serving clients for over 10 years" are company blurbs, not seniority
// bars, and they are common enough that including them would misfire often.
// `(?<!\d)` is what stops "110+ years" being read as "10+ years".
const YEARS_REQUIREMENT_PATTERNS = [
  // "8+ years", "10 + yrs", "10 or more years"
  /(?<!\d)(\d{1,2})\s*(?:\+|or\s+more)\s*(?:years?|yrs?)(?![a-z])/g,
  // "8-12 years" - the lower bound is the requirement being stated
  /(?<!\d)(\d{1,2})\s*[-–]\s*\d{1,2}\s*(?:years?|yrs?)(?![a-z])/g,
  // "at least 10 years", "minimum of 10 years", "min. 10 yrs"
  /(?:at\s+least|minimum(?:\s+of)?|min\.?)\s+(?<!\d)(\d{1,2})\s*(?:years?|yrs?)(?![a-z])/g,
];

function requiresTooManyYears(text: string): boolean {
  for (const pattern of YEARS_REQUIREMENT_PATTERNS) {
    // These regexes are module-level and /g, so lastIndex must be reset or a
    // previous call would leak its cursor into this one.
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (Number(match[1]) >= OVER_EXPERIENCED_YEARS) return true;
    }
  }
  return false;
}

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

const TARGET_ROLE_TOKENS = TARGET_ROLES.map((role) =>
  titleTokens(role.toLowerCase()).map(canonicalRoleToken)
).filter((tokens) => tokens.length > 0);

// Veto phrases are compared as raw tokens: none of them contains a role noun,
// so canonicalisation would be a no-op and folding it in would only blur the
// line between the policy list and the matching rules.
const ROLE_VETOES = ROLE_VETO_PHRASES.map((phrase) => ({
  phrase,
  tokens: titleTokens(phrase.toLowerCase()),
})).filter((veto) => veto.tokens.length > 0);

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
function vetoedRolePhrase(title: string): string | null {
  const clauses = titleClauses(title).map(titleTokens);
  const hit = ROLE_VETOES.find((veto) =>
    clauses.some((tokens) => containsAdjacent(tokens, veto.tokens))
  );
  return hit ? hit.phrase : null;
}

function matchesTargetRole(title: string): boolean {
  return TARGET_ROLE_TOKENS.some((role) =>
    titleClauses(title).some((clause) =>
      containsInOrder(titleTokens(clause).map(canonicalRoleToken), role)
    )
  );
}

function roleVetoReason(phrase: string): string {
  return `title is a non-engineering role ("${phrase}") - excluded regardless of the skills below`;
}

/**
 * Scores a job 0-100 against Ribhu's resume skills + target roles.
 * Returns the score plus human-readable reasons (shown in the dashboard so
 * it's obvious *why* something ranked where it did, not a black box).
 *
 * One hard exclusion: a title naming a non-engineering role (see
 * ROLE_VETO_PHRASES) scores 0 regardless of its skill evidence.
 */
export function scoreJob(job: RawJob): { score: number; reasons: string[] } {
  const text = haystack(job.title, job.company, job.description, job.tags);
  const reasons: string[] = [];
  const vetoPhrase = vetoedRolePhrase(job.title || "");
  let raw = 0;

  for (const skill of SKILL_MATCHERS) {
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
  if (!vetoPhrase && matchesTargetRole(title)) {
    raw += 8;
    reasons.push("title matches a targeted role");
  }

  // Remote preference - remote is the stated preference, not a hard filter.
  //
  // Three states, not two: plenty of sources simply never say. Scoring an
  // unknown as if it were a confirmed on-site role both understates the job
  // and puts a claim in the reasons list that the data does not support, so
  // unknown gets no bonus, no penalty, and a reason that says so.
  if (job.remote === true) {
    raw += 4;
    reasons.push("remote");
  } else if (job.remote === false) {
    reasons.push("NOT remote - lower priority");
  } else {
    reasons.push("remote status not stated by this source");
  }

  // Seniority guard: penalize roles that read as far too junior, or that set an
  // experience floor Ribhu cannot clear, since his experience is ~3 years but
  // at a senior scope (led 15 engineers, architected multi-agent systems).
  if (/\b(intern|internship)\b/.test(title)) {
    raw -= 15;
    reasons.push("looks like an internship - deprioritized");
  }
  if (requiresTooManyYears(text)) {
    raw -= 10;
    reasons.push(OVER_EXPERIENCED_REASON);
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
      Math.round((raw / Math.max(MAX_SKILL_WEIGHT * FULL_CREDIT_FRACTION, 1)) * 100)
    )
  );

  return { score: normalized, reasons };
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
