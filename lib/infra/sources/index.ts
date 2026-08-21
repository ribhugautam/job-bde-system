import { safeFetchSource, RawJob, RawLead } from "./types";
import { JOB_SOURCES, LEAD_SOURCES, type SourceDefinition } from "./registry";
import type { Settings } from "@/lib/config/settings";

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
//
//      `retired` is a third, separate list for the same reason `skipped` was
//      split from `errors`. A retired source is not broken and is not something
//      the operator turned off — it is an upstream that no longer exists. Left
//      in `errors` it demanded a fix that cannot be made; left in `skipped` it
//      implied a flag that would bring it back.

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type RunResult<T> = {
  items: T[];
  errors: string[];
  skipped: string[];
  retired: string[];
};

/** An active source, i.e. one that survived the retired/enabled/fetch checks. */
type Runnable<T> = SourceDefinition<T> & { fetch: () => Promise<T[]> };

async function runSources<T>(
  sources: SourceDefinition<T>[],
  settings: Settings
): Promise<RunResult<T>> {
  const active: Runnable<T>[] = [];
  const skipped: string[] = [];
  const retired: string[] = [];
  const errors: string[] = [];

  for (const source of sources) {
    // Checked FIRST, and deliberately before enabled(). A retired source must
    // report as retired whatever its flag says — otherwise setting the flag
    // would move it from "retired" back to a normal-looking active source that
    // fails on every run, which is exactly the loop this replaced.
    if (source.retired) {
      retired.push(`${source.name}: ${source.retired.reason}`);
      continue;
    }

    let on: boolean;
    try {
      on = source.enabled(settings);
    } catch (err) {
      // enabled() is supplied by the registry and could still throw on a
      // malformed configuration. Report it against the source and keep going
      // rather than aborting the whole run.
      errors.push(`${source.name}: ${describe(err)}`);
      continue;
    }

    if (on) {
      if (!source.fetch) {
        // Only reachable if someone writes an active definition with no
        // fetcher. That is a bug in the registry, not a runtime condition, so
        // it is reported as an error rather than silently producing nothing.
        errors.push(
          `${source.name}: enabled but has no fetch(); a source is only allowed ` +
            `to omit fetch when it is marked retired`
        );
        continue;
      }
      active.push(source as Runnable<T>);
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
    active.map((source) =>
      safeFetchSource(source.name, () => source.fetch(settings))
    )
  );

  return {
    items: results.flatMap((r) => r.items),
    errors: [...errors, ...(results.map((r) => r.error).filter(Boolean) as string[])],
    skipped,
    retired,
  };
}

/**
 * `sources` is a test seam: production calls this with no arguments and gets
 * the real registry. Tests pass fakes so no test ever touches the network.
 */
export async function fetchAllJobs(
  settings: Settings,
  sources: SourceDefinition<RawJob>[] = JOB_SOURCES
): Promise<{
  jobs: RawJob[];
  errors: string[];
  skipped: string[];
  retired: string[];
}> {
  const { items, errors, skipped, retired } = await runSources(sources, settings);
  return { jobs: items, errors, skipped, retired };
}

/** See the note on `sources` in fetchAllJobs. */
export async function fetchAllLeads(
  settings: Settings,
  sources: SourceDefinition<RawLead>[] = LEAD_SOURCES
): Promise<{
  leads: RawLead[];
  errors: string[];
  skipped: string[];
  retired: string[];
}> {
  const { items, errors, skipped, retired } = await runSources(sources, settings);
  return { leads: items, errors, skipped, retired };
}

export { JOB_SOURCES, LEAD_SOURCES };
export type { SourceDefinition, SourceKind } from "./registry";
