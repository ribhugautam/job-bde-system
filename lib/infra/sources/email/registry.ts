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
  parse: parseIndeedAlert,
  tags: ["indeed-alert"],
};
