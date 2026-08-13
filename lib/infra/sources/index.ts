import { safeFetchSource, RawJob, RawLead } from "./types";
import { JOB_SOURCES, LEAD_SOURCES, type SourceDefinition } from "./registry";

// The fan-out over every configured source. The source list itself lives in
// registry.ts — this file only knows how to run one.
//
// Two guarantees this layer owes the daily cron:
//
//   1. FAIL-SAFE. One broken source must never take down the run. Every fetch
//      goes through safeFetchSource, and even a source's own enabled() call is
//      wrapped, because it reads getEnv() which throws on a bad configuration.
//      Whatever goes wrong ends up as a string in `errors`, never a rejection.
//
//   2. VISIBILITY. A source that is switched off is reported in `skipped` with
//      the reason it is off, so "Adzuna found nothing today" and "Adzuna has no
//      API key" never look the same in the digest.

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type RunResult<T> = { items: T[]; errors: string[]; skipped: string[] };

async function runSources<T>(
  sources: SourceDefinition<T>[]
): Promise<RunResult<T>> {
  const active: SourceDefinition<T>[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const source of sources) {
    let on: boolean;
    try {
      on = source.enabled();
    } catch (err) {
      // A malformed environment makes getEnv() throw. Report it against the
      // source and keep going rather than aborting the whole run.
      errors.push(`${source.name}: ${describe(err)}`);
      continue;
    }

    if (on) {
      active.push(source);
      continue;
    }

    let reason: string | undefined;
    try {
      reason = source.disabledReason?.();
    } catch (err) {
      reason = `disabledReason failed: ${describe(err)}`;
    }
    skipped.push(reason ? `${source.name}: ${reason}` : source.name);
  }

  const results = await Promise.all(
    active.map((source) => safeFetchSource(source.name, () => source.fetch()))
  );

  return {
    items: results.flatMap((r) => r.items),
    errors: [...errors, ...(results.map((r) => r.error).filter(Boolean) as string[])],
    skipped,
  };
}

/**
 * `sources` is a test seam: production calls this with no arguments and gets
 * the real registry. Tests pass fakes so no test ever touches the network.
 */
export async function fetchAllJobs(
  sources: SourceDefinition<RawJob>[] = JOB_SOURCES
): Promise<{ jobs: RawJob[]; errors: string[]; skipped: string[] }> {
  const { items, errors, skipped } = await runSources(sources);
  return { jobs: items, errors, skipped };
}

/** See the note on `sources` in fetchAllJobs. */
export async function fetchAllLeads(
  sources: SourceDefinition<RawLead>[] = LEAD_SOURCES
): Promise<{ leads: RawLead[]; errors: string[]; skipped: string[] }> {
  const { items, errors, skipped } = await runSources(sources);
  return { leads: items, errors, skipped };
}

export { JOB_SOURCES, LEAD_SOURCES };
export type { SourceDefinition, SourceKind } from "./registry";
