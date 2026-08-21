import {
  ROLE_VETO_PHRASES,
  SKILL_TAXONOMY,
  TARGET_ROLE_VOCABULARY,
  type TaxonomySkill,
} from "./taxonomy";
import { defaultProfile, type ProfileSkill, type ScoringProfile } from "./profile";

// ---------------------------------------------------------------------------
// Turning resume TEXT into a scoring profile. Pure: no PDF library, no
// database, no network — it takes a string. lib/infra/pdf/text.ts is what gets
// a string out of a PDF, and it is deliberately the only part that needs a
// dependency, so everything interesting here is testable against fixtures.
//
// NO LLM, on purpose. The whole system scores without one (see
// lib/domain/scoring/score.ts) and staying free and offline is worth more here
// than the accuracy an extraction model would add — especially since the result
// is shown to the user on an editable page, where a miss costs one correction
// rather than a wrong ranking forever.
//
// The bias is deliberately toward UNDER-claiming. A skill that is missed is one
// the user adds in a moment; a skill that is wrongly claimed silently inflates
// every score that mentions it, and the user has no reason to go looking.
// ---------------------------------------------------------------------------

export type ExtractionResult = {
  profile: ScoringProfile;
  /** What was found, for showing the user what happened rather than hiding it. */
  found: {
    skills: string[];
    targetRoles: string[];
    careerStart: Date | null;
    /** True when the text was too short/garbled to treat as a resume. */
    lowConfidence: boolean;
  };
};

/**
 * Word-boundary matching, same approach as the scorer.
 *
 * A plain `includes()` would credit "ts" inside *documents*, "go" inside
 * *category*, "rag" inside *storage* and "ml" inside *html* — on a resume,
 * which is dense with exactly those words, that is not a rare edge case but the
 * common one. The lookarounds are applied only on the side where the token
 * genuinely begins or ends with an alphanumeric, because several skill names
 * start or end in punctuation (".net", "c#", "next.js") and `\b` asserts the
 * opposite of what you want on a punctuation edge.
 */
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

function tokenPattern(rawToken: string): RegExp {
  const token = rawToken.toLowerCase();
  const body = token.replace(REGEX_METACHARACTERS, "\\$&");
  const left = /^[a-z0-9]/.test(token) ? "(?<![a-z0-9])" : "";
  const right = /[a-z0-9]$/.test(token) ? "s?(?![a-z0-9])" : "";
  return new RegExp(left + body + right);
}

function mentions(text: string, skill: TaxonomySkill): boolean {
  return [skill.name, ...(skill.aliases ?? [])]
    .map(tokenPattern)
    .some((pattern) => pattern.test(text));
}

/**
 * Resumes below this length are almost certainly a failed text extraction —
 * an image-only scan, or a PDF whose fonts carry no extractable text. Treated
 * as low confidence so the UI can say "we could not read this" instead of
 * presenting an empty profile as a finished answer.
 */
const MIN_RESUME_CHARS = 200;

/** A skill named this many times or more is treated as a stronger claim. */
const EMPHASIS_THRESHOLD = 3;

function countOccurrences(text: string, skill: TaxonomySkill): number {
  let total = 0;
  for (const token of [skill.name, ...(skill.aliases ?? [])]) {
    const pattern = new RegExp(tokenPattern(token).source, "g");
    total += (text.match(pattern) ?? []).length;
  }
  return total;
}

// --- Career start ----------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Every "Mon YYYY" or bare "YYYY" that could plausibly be a work date.
 *
 * The floor of 1980 and the ceiling of "this year" exist because resumes are
 * full of numbers that look like years and are not — postcodes, phone
 * fragments, "99.9% uptime", version numbers, "top 500". An out-of-range
 * number is far more likely to be one of those than a job date.
 */
function candidateDates(text: string, now: Date): Date[] {
  const out: Date[] = [];
  const thisYear = now.getFullYear();

  const monthYear = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{4})\b/gi;
  for (const match of text.matchAll(monthYear)) {
    const year = Number(match[2]);
    if (year < 1980 || year > thisYear) continue;
    out.push(new Date(Date.UTC(year, MONTHS[match[1].toLowerCase().slice(0, 3)], 1)));
  }

  return out;
}

/**
 * The earliest plausible work date in the resume.
 *
 * Deliberately conservative, and deliberately month-anchored: a bare four-digit
 * year is ambiguous between a job start, a graduation, and a project date, and
 * education dates are exactly the ones that would make somebody look years more
 * experienced than they are. Requiring a month cuts almost all of that, because
 * employment ranges are written "Dec 2023 - Present" while degrees are usually
 * written as bare years.
 *
 * Returns null rather than guessing when nothing qualifies — the profile then
 * skips experience adjustments entirely, which is the honest outcome.
 */
export function extractCareerStart(text: string, now: Date = new Date()): Date | null {
  const dates = candidateDates(text, now);
  if (dates.length === 0) return null;

  const earliest = dates.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));

  // A "career" starting more than 50 years ago is a parse artefact, not a
  // person still applying for engineering roles.
  const fiftyYears = 50 * 365.25 * 24 * 60 * 60 * 1000;
  if (now.getTime() - earliest.getTime() > fiftyYears) return null;

  return earliest;
}

// --- Target roles ----------------------------------------------------------

/**
 * Role titles the resume actually names.
 *
 * Matched against the shared vocabulary rather than parsed freely: "what job
 * title is this line" is a hard problem, and a wrong answer here hands out the
 * title bonus for roles the person is not going for. Recognising a known title
 * is a much easier problem with a much cheaper failure mode.
 */
export function extractTargetRoles(text: string): string[] {
  const found = TARGET_ROLE_VOCABULARY.filter((role) => {
    // Roles are multi-word; match the words in order with gaps allowed, so
    // "Senior Full Stack Developer" satisfies "full stack developer".
    const words = role.split(/\s+/).map((w) => tokenPattern(w).source);
    return new RegExp(words.join("[\\s\\w.,/-]{0,20}?"), "i").test(text);
  });

  // A resume naming a vetoed role ("Sales Engineer") must not turn that into a
  // target. The veto list is policy about what this tool is for.
  return found.filter(
    (role) => !ROLE_VETO_PHRASES.some((veto) => role.includes(veto))
  );
}

// --- Skills ----------------------------------------------------------------

export function extractSkills(text: string): ProfileSkill[] {
  return SKILL_TAXONOMY.filter((skill) => mentions(text, skill)).map((skill) => {
    const hits = countOccurrences(text, skill);
    return {
      name: skill.name,
      // A skill the resume returns to repeatedly is weighted one step above its
      // taxonomy default, capped so a keyword-stuffed resume cannot run away
      // with the scale. Everything else keeps the shared default.
      weight: hits >= EMPHASIS_THRESHOLD ? Math.min(skill.weight + 1, 5) : skill.weight,
      aliases: skill.aliases,
    };
  });
}

// --- The whole thing -------------------------------------------------------

export function extractProfile(
  resumeText: string,
  now: Date = new Date()
): ExtractionResult {
  const text = resumeText.toLowerCase();
  const lowConfidence = text.trim().length < MIN_RESUME_CHARS;

  const skills = extractSkills(text);
  const targetRoles = extractTargetRoles(text);
  const careerStart = extractCareerStart(text, now);

  // A resume we could not read falls back to the default profile rather than
  // to an empty one. An empty skill list scores every job 0, which looks like
  // a broken app rather than a failed upload; `lowConfidence` is what tells the
  // UI to say so plainly.
  const base = defaultProfile();

  return {
    profile: {
      skills: lowConfidence || skills.length === 0 ? base.skills : skills,
      targetRoles: targetRoles.length ? targetRoles : base.targetRoles,
      // Veto phrases stay shared policy: they describe what this tool is for,
      // not anything the resume could tell us.
      vetoPhrases: base.vetoPhrases,
      careerStart,
      // Nothing in a resume says whether somebody will take an on-site role, so
      // this is never extracted — it keeps the default and is set by the user.
      acceptedArrangements: base.acceptedArrangements,
    },
    found: {
      skills: skills.map((s) => s.name),
      targetRoles,
      careerStart,
      lowConfidence,
    },
  };
}
