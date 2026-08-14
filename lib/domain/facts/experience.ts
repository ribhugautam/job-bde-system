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
