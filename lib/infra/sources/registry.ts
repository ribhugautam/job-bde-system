import { getEnv } from "@/lib/config/env";
import type { RawJob, RawLead } from "./types";
import { fetchRemoteOk } from "./remoteok";
import { fetchRemotive } from "./remotive";
import { fetchArbeitnow, fetchArbeitnowContractLeads } from "./arbeitnow";
import {
  fetchWeWorkRemotely,
  fetchWeWorkRemotelyContractLeads,
} from "./weworkremotely";
import { fetchUpworkLeads } from "./upwork";
import { fetchHimalayas } from "./himalayas";
import { fetchJobicy } from "./jobicy";
import { fetchAdzuna } from "./adzuna";
import { fetchLinkedInAlerts } from "../linkedin/alerts";
import { fetchAlertSource } from "@/lib/infra/mail/alert-ingest";
import { WELLFOUND_ALERTS, INDEED_ALERTS } from "./email/registry";

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

export type SourceDefinition<T> = {
  /** Stable id persisted in the `source` DB column — NEVER change existing values. */
  name: string;
  kind: SourceKind;
  fetch: () => Promise<T[]>;
  /** Evaluated per run, reads getEnv() — so a flag flip takes effect without a redeploy. */
  enabled: () => boolean;
  /** Why a source is off, surfaced in the dashboard/digest instead of it silently vanishing. */
  disabledReason?: () => string | undefined;
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
    // Experimental and unverified — Upwork has tightened RSS access before
    // without notice, so this stays off until you confirm the feed loads.
    name: "upwork_rss",
    kind: "lead",
    fetch: fetchUpworkLeads,
    enabled: () => getEnv().ENABLE_UPWORK_RSS,
    disabledReason: () =>
      getEnv().ENABLE_UPWORK_RSS
        ? undefined
        : "experimental; set ENABLE_UPWORK_RSS=1 to enable after confirming the " +
          "Upwork RSS feed still loads in a browser",
  },
];
