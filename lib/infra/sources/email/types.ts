import type { WorkArrangement } from "@/lib/domain/facts";

// ---------------------------------------------------------------------------
// The contract every email-alert parser satisfies.
//
// Parsers are pure functions over an HTML string: no network, no mailbox, no
// database. That is what lets them be tested against a real captured email and
// nothing else. lib/infra/mail/alert-ingest.ts owns everything impure.
// ---------------------------------------------------------------------------

export type ParsedAlertJob = {
  /**
   * Stable identifier for this posting WITHIN this source. Becomes `source_id`,
   * so it must be derivable from the same posting in a later email — never a
   * per-send tracking token. Indeed has a real job key in its links; Wellfound
   * does not, so its parser derives one (see lib/infra/sources/email/wellfound.ts).
   */
  id: string;
  title: string;
  company: string;
  location?: string;
  url: string;
  arrangement?: WorkArrangement;
  easyApply?: boolean;
  /** Description snippet when the digest carries one — Indeed does, LinkedIn does not. */
  description?: string;
  salaryText?: string;
  /** Years of experience when the digest states it — Wellfound does. */
  minYears?: number;
};

export type AlertSource = {
  /** Persisted `source` column value — NEVER rename an existing one. */
  name: string;
  /** Sender domain, handed to the server-side IMAP SEARCH so only this sender's mail is fetched. */
  fromDomain: string;
  /** Lookback window in days. */
  days: number;
  /**
   * Rejects non-job mail from the same sender before parsing.
   *
   * Wellfound sends two shapes from one address: "New jobs: ..." digests and
   * "An update from Univaens, ParallelDots and 37 others" company-activity
   * mail. Parsing the second would manufacture rows out of nothing.
   */
  subjectFilter?: (subject: string) => boolean;
  parse: (html: string) => ParsedAlertJob[];
  /** Tags applied to every job from this source, for provenance in the dashboard. */
  tags: string[];
};
