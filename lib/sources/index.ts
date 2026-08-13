import { safeFetchSource, RawJob, RawLead } from "./types";
import { fetchRemoteOk } from "./remoteok";
import { fetchRemotive } from "./remotive";
import { fetchArbeitnow, fetchArbeitnowContractLeads } from "./arbeitnow";
import {
  fetchWeWorkRemotely,
  fetchWeWorkRemotelyContractLeads,
} from "./weworkremotely";
import { fetchUpworkLeads } from "./upwork";

export async function fetchAllJobs(): Promise<{
  jobs: RawJob[];
  errors: string[];
}> {
  const results = await Promise.all([
    safeFetchSource("remoteok", fetchRemoteOk),
    safeFetchSource("remotive", fetchRemotive),
    safeFetchSource("arbeitnow", fetchArbeitnow),
    safeFetchSource("wwr", fetchWeWorkRemotely),
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
