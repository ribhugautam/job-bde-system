import { safeFetchSource, RawJob, RawLead } from "./types";
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
import { fetchLinkedInAlerts } from "./linkedin-alerts";

export async function fetchAllJobs(): Promise<{
  jobs: RawJob[];
  errors: string[];
}> {
  const results = await Promise.all([
    safeFetchSource("remoteok", fetchRemoteOk),
    safeFetchSource("remotive", fetchRemotive),
    safeFetchSource("arbeitnow", fetchArbeitnow),
    safeFetchSource("wwr", fetchWeWorkRemotely),
    // Remote-only, worldwide, no key. Best coverage of the set.
    safeFetchSource("himalayas", fetchHimalayas),
    safeFetchSource("jobicy", fetchJobicy),
    // No-ops unless ADZUNA_APP_ID / ADZUNA_APP_KEY are set.
    safeFetchSource("adzuna", fetchAdzuna),
    // No-op unless ENABLE_LINKEDIN_ALERTS=1. Reads your own inbox, not LinkedIn.
    safeFetchSource("linkedin_alert", fetchLinkedInAlerts),
  ]);
  const jobs = results.flatMap((r) => r.items);
  const errors = results.map((r) => r.error).filter(Boolean) as string[];
  return { jobs, errors };
}

export async function fetchAllLeads(): Promise<{
  leads: RawLead[];
  errors: string[];
}> {
  const results = await Promise.all([
    safeFetchSource("arbeitnow_contract", fetchArbeitnowContractLeads),
    safeFetchSource("wwr_contract", fetchWeWorkRemotelyContractLeads),
    safeFetchSource("upwork_rss", fetchUpworkLeads),
  ]);
  const leads = results.flatMap((r) => r.items);
  const errors = results.map((r) => r.error).filter(Boolean) as string[];
  return { leads, errors };
}
