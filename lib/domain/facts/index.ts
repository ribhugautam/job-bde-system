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
