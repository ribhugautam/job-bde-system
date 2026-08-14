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
