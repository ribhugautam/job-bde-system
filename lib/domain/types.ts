// Core domain shapes. These describe a job or lead as the rest of the system
// reasons about it, independent of which board it came from.
//
// They live in domain/ (not infra/sources/) so that scoring, fingerprinting and
// drafting can import them without reaching into the infrastructure layer. That
// one-way dependency — domain never imports infra — is what keeps those modules
// unit-testable with plain data and no fixtures.

export type RawJob = {
  source: string;
  sourceId: string;
  title: string;
  company: string;
  companyUrl?: string;
  url: string;
  applyEmail?: string;
  location?: string;
  remote?: boolean;
  salaryText?: string;
  tags?: string[];
  description?: string;
  postedAt?: Date;
  /**
   * True when the source gave us only a title/company/link and no description.
   *
   * Historically this meant LinkedIn alert emails, which were scored against a
   * separate lower threshold to stop them being discarded wholesale. The enrich
   * stage now recovers descriptions from the public job page, so this flag
   * survives only to mark the residue that enrichment could not reach — a job
   * still carrying it after the enrich stage genuinely has no description, and
   * its score should be read as title-only evidence.
   */
  sparse?: boolean;
};

export type RawLead = {
  source: string;
  sourceId: string;
  title: string;
  clientOrCompany?: string;
  url: string;
  contactEmail?: string;
  budgetText?: string;
  description?: string;
  postedAt?: Date;
};
