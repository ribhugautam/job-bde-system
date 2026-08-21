import { getEnv } from "@/lib/config/env";
import type { RawJob, RawLead } from "./types";
import { fetchRemoteOk } from "./remoteok";
import { fetchRemotive } from "./remotive";
import { fetchArbeitnow, fetchArbeitnowContractLeads } from "./arbeitnow";
import {
  fetchWeWorkRemotely,
  fetchWeWorkRemotelyContractLeads,
} from "./weworkremotely";
import { fetchHimalayas } from "./himalayas";
import { fetchJobicy } from "./jobicy";
import { fetchAdzuna } from "./adzuna";
import { fetchLinkedInAlerts } from "../linkedin/alerts";
import { fetchAlertSource } from "@/lib/infra/mail/alert-ingest";
import { WELLFOUND_ALERTS, INDEED_ALERTS } from "./email/registry";
import { fetchYCombinator } from "./ycombinator";

// ---------------------------------------------------------------------------
// The single declaration of every job board this system pulls from.
//
// Previously the list lived twice inside index.ts as literal safeFetchSource()
// arrays, and each source's "am I switched on?" rule was buried inside its own
// fetcher as an early `return []`. That had two costs: adding a source meant
// editing two arrays, and a source that was off simply produced nothing —
// indistinguishable, from the outside, from a source that ran and found no
// jobs. Enablement is declared here instead, so a disabled source can be
// reported as disabled (with the fix) rather than silently vanishing.
//
// ---------------------------------------------------------------------------
// `name` IS A PERSISTED VALUE. It is written to the `source` column and forms
// half of the (source, sourceId) dedupe key. Renaming one orphans every row
// already stored under the old name, which would re-surface jobs already
// applied to and re-send those applications. Add new names freely; never
// change an existing one.
// ---------------------------------------------------------------------------

export type SourceKind = "job" | "lead";

/**
 * A source whose upstream is gone for good.
 *
 * Distinct from `enabled() === false`, and the distinction is the whole point.
 * A disabled source is one YOU switched off and could switch back on; a retired
 * source is one the *upstream* removed, where flipping any flag would only
 * re-request a URL that will never answer again. Reporting the second as the
 * first sent an operator looking for a config mistake that did not exist.
 *
 * A retired entry keeps its `name` and carries no `fetch` at all — see the
 * tombstone note on upwork_rss below for why the entry cannot simply be
 * deleted.
 */
export type RetirementNotice = {
  /** ISO date the retirement was confirmed, so the tombstone dates itself. */
  since: string;
  /** What happened upstream, in words an operator can act on (or stop acting on). */
  reason: string;
};

export type SourceDefinition<T> = {
  /** Stable id persisted in the `source` DB column — NEVER change existing values. */
  name: string;
  kind: SourceKind;
  /**
   * Absent only on retired sources. index.ts short-circuits on `retired`
   * before it would ever reach this, and reports an active source missing a
   * fetcher as an error rather than crashing the run.
   */
  fetch?: () => Promise<T[]>;
  /** Evaluated per run, reads getEnv() — so a flag flip takes effect without a redeploy. */
  enabled: () => boolean;
  /** Why a source is off, surfaced in the dashboard/digest instead of it silently vanishing. */
  disabledReason?: () => string | undefined;
  /** Set when the upstream is permanently gone. Overrides `enabled()` entirely. */
  retired?: RetirementNotice;
};

/** Sources with no configuration of their own: open APIs, no key, always on. */
const always = () => true;

// --- Conditional enablement rules -----------------------------------------

/** Adzuna needs a (free) key pair; either one missing means the API 401s. */
function adzunaKeys(): { id?: string; key?: string } {
  const env = getEnv();
  return { id: env.ADZUNA_APP_ID, key: env.ADZUNA_APP_KEY };
}

function adzunaEnabled(): boolean {
  const { id, key } = adzunaKeys();
  return Boolean(id && key);
}

function adzunaDisabledReason(): string | undefined {
  const { id, key } = adzunaKeys();
  const missing = [!id && "ADZUNA_APP_ID", !key && "ADZUNA_APP_KEY"].filter(
    Boolean
  ) as string[];
  if (!missing.length) return undefined;
  // Naming the specific missing key matters: setting only one of the pair is
  // the common typo, and "Adzuna is off" alone would not point at it.
  return `set ${missing.join(
    " and "
  )} to enable (free key: https://developer.adzuna.com/signup)`;
}

// --- The registries --------------------------------------------------------

export const JOB_SOURCES: SourceDefinition<RawJob>[] = [
  { name: "remoteok", kind: "job", fetch: fetchRemoteOk, enabled: always },
  { name: "remotive", kind: "job", fetch: fetchRemotive, enabled: always },
  { name: "arbeitnow", kind: "job", fetch: fetchArbeitnow, enabled: always },
  { name: "wwr", kind: "job", fetch: fetchWeWorkRemotely, enabled: always },
  // Remote-only, worldwide, no key. Best coverage of the set.
  { name: "himalayas", kind: "job", fetch: fetchHimalayas, enabled: always },
  { name: "jobicy", kind: "job", fetch: fetchJobicy, enabled: always },
  {
    name: "adzuna",
    kind: "job",
    fetch: fetchAdzuna,
    enabled: adzunaEnabled,
    disabledReason: adzunaDisabledReason,
  },
  {
    // Reads your own inbox over IMAP. Does not touch LinkedIn — see
    // lib/infra/linkedin/alerts.ts for why.
    name: "linkedin_alert",
    kind: "job",
    fetch: fetchLinkedInAlerts,
    enabled: () => getEnv().ENABLE_LINKEDIN_ALERTS,
    disabledReason: () =>
      getEnv().ENABLE_LINKEDIN_ALERTS
        ? undefined
        : "set ENABLE_LINKEDIN_ALERTS=1 to enable (needs IMAP_USER/IMAP_PASSWORD, " +
          "or the existing GMAIL_USER/GMAIL_APP_PASSWORD)",
  },
  {
    // Reads your own inbox over IMAP, read-only. Same approach as
    // linkedin_alert — no Wellfound account is authenticated, nothing is
    // scraped from a logged-in surface.
    name: "wellfound_alert",
    kind: "job",
    fetch: () => fetchAlertSource(WELLFOUND_ALERTS),
    enabled: () => getEnv().ENABLE_WELLFOUND_ALERTS,
    disabledReason: () =>
      getEnv().ENABLE_WELLFOUND_ALERTS
        ? undefined
        : "set ENABLE_WELLFOUND_ALERTS=1 to enable (needs IMAP_USER/IMAP_PASSWORD, " +
          "or the existing GMAIL_USER/GMAIL_APP_PASSWORD)",
  },
  {
    name: "indeed_alert",
    kind: "job",
    fetch: () => fetchAlertSource(INDEED_ALERTS),
    enabled: () => getEnv().ENABLE_INDEED_ALERTS,
    disabledReason: () =>
      getEnv().ENABLE_INDEED_ALERTS
        ? undefined
        : "set ENABLE_INDEED_ALERTS=1 to enable (needs IMAP_USER/IMAP_PASSWORD, " +
          "or the existing GMAIL_USER/GMAIL_APP_PASSWORD)",
  },
  {
    // Public, unauthenticated page. No key, no account, always on.
    name: "ycombinator",
    kind: "job",
    fetch: fetchYCombinator,
    enabled: always,
  },
];

export const LEAD_SOURCES: SourceDefinition<RawLead>[] = [
  {
    name: "arbeitnow_contract",
    kind: "lead",
    fetch: fetchArbeitnowContractLeads,
    enabled: always,
  },
  {
    name: "wwr_contract",
    kind: "lead",
    fetch: fetchWeWorkRemotelyContractLeads,
    enabled: always,
  },
  {
    // ---------------------------------------------------------------------
    // TOMBSTONE. Upwork retired its public RSS job feeds: the endpoint answers
    // 410 Gone, which is HTTP for "permanently removed, stop asking". There is
    // no fetcher to repair and no flag to set — hence `retired` rather than
    // `enabled: () => false`, which would have read as "you switched this off".
    //
    // The entry itself STAYS. `name` is a persisted value and half the
    // (source, source_id) dedupe key, so deleting it would orphan every lead
    // already ingested under it. A tombstone costs nothing; an orphaned key
    // costs re-pitching clients that were already contacted.
    // ---------------------------------------------------------------------
    name: "upwork_rss",
    kind: "lead",
    enabled: () => false,
    retired: {
      since: "2026-08-21",
      reason:
        "Upwork retired its public RSS job feeds; the endpoint returns 410 Gone. " +
        "Nothing to configure — this source cannot be re-enabled.",
    },
  },
];
