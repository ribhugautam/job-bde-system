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
  // indeed.com sends far more than job digests: application-status updates,
  // saved-search nudges, password resets. parseIndeedAlert reads title and
  // company POSITIONALLY off the first two lines, which is only a valid
  // shortcut for the digest template — fed anything else, it would store
  // whatever text sits there as a fabricated job's title and company.
  //
  // DELIBERATELY PERMISSIVE, not a tight allowlist. The two observed digest
  // subject shapes are "Apply to jobs at X, Y and Z" and "<Title> @
  // <Company>", so this matches either the "apply to jobs" opener or a bare
  // "@" anywhere in the subject. The operator's original complaint was jobs
  // NOT showing up, so silently dropping a real alert because its subject
  // wording drifted is worse than the occasional malformed row — and a
  // malformed row is cheap here anyway, because the parser's own positional
  // guards already degrade a bad card to a skipped one rather than a
  // confident wrong value.
  subjectFilter: (subject) => /^apply to jobs\b|@/i.test(subject.trim()),
  parse: parseIndeedAlert,
  tags: ["indeed-alert"],
};
