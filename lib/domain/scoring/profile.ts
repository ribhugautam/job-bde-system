import type { WorkArrangement } from "@/lib/domain/facts";
import {
  DEFAULT_PROFILE_SKILLS,
  DEFAULT_TARGET_ROLES,
  ROLE_VETO_PHRASES,
  type TaxonomySkill,
} from "./taxonomy";

// ---------------------------------------------------------------------------
// One person's scoring profile. Pure: no database, no React.
//
// This is what replaced the module-level constants the matcher used to read
// straight out of resume-profile.ts. Those constants were one user's resume
// compiled into the program, so "rank jobs against MY resume" was not a thing
// the system could express for anybody else.
//
// Everything here is per-user EXCEPT geographic eligibility — see the note on
// `acceptedArrangements` below.
// ---------------------------------------------------------------------------

export type ProfileSkill = {
  name: string;
  weight: number;
  aliases?: string[];
};

export type ScoringProfile = {
  skills: ProfileSkill[];
  /** Job titles this person is actually going for. Drives the title bonus. */
  targetRoles: string[];
  /** Shared policy plus anything they add. A veto is fatal — see taxonomy.ts. */
  vetoPhrases: string[];
  /**
   * When their professional career started, used to judge experience
   * requirements. Null means unknown, and every experience adjustment is then
   * SKIPPED rather than guessed — a wrong seniority penalty is worse than none.
   */
  careerStart: Date | null;
  /**
   * Arrangements this person will actually take. Empty means no preference,
   * which scores every arrangement neutrally.
   *
   * This is where the filter chips went. With no filter bar, "I don't want
   * on-site" has to be expressed somewhere, and expressing it as a ranking
   * input rather than a hard filter means an outstanding hybrid role can still
   * surface above a mediocre remote one instead of being hidden outright.
   *
   * NOT per-user, deliberately: geographic eligibility. `jobs.geoEligibility`
   * is derived at ingest against India (see lib/domain/facts/geo.ts) and stored
   * on the shared row, so it is the same answer for everyone. Correct for this
   * team, and a documented limitation for anyone hiring outside it — making it
   * per-user means re-deriving a shared fact per viewer, which is a different
   * and much larger change.
   */
  acceptedArrangements: WorkArrangement[];
};

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/** Years of professional experience, or null when the career start is unknown. */
export function yearsOfExperience(
  careerStart: Date | null,
  now: Date = new Date()
): number | null {
  if (!careerStart) return null;
  return Math.max(0, (now.getTime() - careerStart.getTime()) / MS_PER_YEAR);
}

function toProfileSkill(skill: TaxonomySkill): ProfileSkill {
  return { name: skill.name, weight: skill.weight, aliases: skill.aliases };
}

/**
 * The profile used when a user has none yet.
 *
 * Not empty and not the whole taxonomy — see DEFAULT_PROFILE_SKILLS in
 * taxonomy.ts for why both extremes rank badly. An empty skill list scores
 * every job 0; the full dictionary inflates the normalisation denominator until
 * nothing clears MATCH_THRESHOLD.
 *
 * `acceptedArrangements` defaults to remote rather than to "no preference",
 * because this is a remote-jobs tool and neutral scoring on that axis would
 * rank an on-site role in another city level with a remote one.
 */
export function defaultProfile(): ScoringProfile {
  return {
    skills: DEFAULT_PROFILE_SKILLS.map(toProfileSkill),
    targetRoles: [...DEFAULT_TARGET_ROLES],
    vetoPhrases: [...ROLE_VETO_PHRASES],
    careerStart: null,
    acceptedArrangements: ["remote"],
  };
}

/**
 * Builds a profile from stored/edited parts, filling anything missing.
 *
 * Total, like the URL filter parsing this replaced: every field can arrive from
 * a JSON column a human has edited, so bad values are dropped rather than
 * thrown on. A malformed profile must rank jobs oddly, never 500 the page.
 */
export function buildProfile(input: {
  skills?: unknown;
  targetRoles?: unknown;
  vetoPhrases?: unknown;
  careerStart?: Date | string | null;
  acceptedArrangements?: unknown;
}): ScoringProfile {
  const base = defaultProfile();

  const skills = Array.isArray(input.skills)
    ? input.skills
        .map((raw): ProfileSkill | null => {
          if (!raw || typeof raw !== "object") return null;
          const { name, weight, aliases } = raw as Record<string, unknown>;
          if (typeof name !== "string" || !name.trim()) return null;
          const parsedWeight = typeof weight === "number" && Number.isFinite(weight)
            ? Math.max(0, Math.min(10, weight))
            : 1;
          return {
            name: name.trim().toLowerCase(),
            weight: parsedWeight,
            aliases: Array.isArray(aliases)
              ? aliases.filter((a): a is string => typeof a === "string")
              : undefined,
          };
        })
        .filter((s): s is ProfileSkill => s !== null)
    : null;

  const strings = (value: unknown): string[] | null =>
    Array.isArray(value)
      ? value
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.trim().toLowerCase())
          .filter(Boolean)
      : null;

  const arrangements = Array.isArray(input.acceptedArrangements)
    ? input.acceptedArrangements.filter((v): v is WorkArrangement =>
        ["remote", "hybrid", "onsite"].includes(v as string)
      )
    : null;

  let careerStart: Date | null = null;
  if (input.careerStart instanceof Date && !Number.isNaN(input.careerStart.getTime())) {
    careerStart = input.careerStart;
  } else if (typeof input.careerStart === "string") {
    const parsed = new Date(input.careerStart);
    if (!Number.isNaN(parsed.getTime())) careerStart = parsed;
  }

  return {
    // An explicitly EMPTY stored list is honoured — that is a user who deleted
    // every skill, not a user who has none yet. Only a missing/invalid value
    // falls back to the default.
    skills: skills ?? base.skills,
    targetRoles: strings(input.targetRoles) ?? base.targetRoles,
    vetoPhrases: strings(input.vetoPhrases) ?? base.vetoPhrases,
    careerStart,
    acceptedArrangements: arrangements ?? base.acceptedArrangements,
  };
}
