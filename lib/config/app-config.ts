import { getEnv, type Env } from "./env";
import { effectiveDryRun, type Settings } from "./settings";
import { getSettings } from "@/lib/infra/db/settings";

// ---------------------------------------------------------------------------
// Secrets + settings, assembled into the one object the rest of the app reads.
//
// Callers that need both used to read a single `Env`. Splitting the sources
// without splitting the consumers keeps that ergonomics: one object, one
// property lookup, no call site having to know which half a given value came
// from.
//
// Assembled per run or per request, never memoised across them. A cached
// settings snapshot is worse than a query here — an admin would flip a toggle
// and watch nothing happen, which is exactly the redeploy-latency problem this
// change exists to remove.
// ---------------------------------------------------------------------------

export type AppConfig = Env &
  Settings & {
    /**
     * The resolved kill switch, already combining both sources.
     *
     * Read THIS, never `DRY_RUN`. The raw settings value alone would ignore a
     * deploy-level `DRY_RUN=1`, which is the one thing that must not be
     * overridable from the dashboard.
     */
    dryRun: boolean;
    /** True when an admin has saved settings; false while these are defaults. */
    settingsConfigured: boolean;
  };

export async function getAppConfig(): Promise<AppConfig> {
  const env = getEnv();
  const settings = await getSettings();

  return {
    ...env,
    ...settings,
    dryRun: effectiveDryRun({
      envDryRun: env.DRY_RUN,
      settingsDryRun: settings.DRY_RUN,
    }),
    settingsConfigured: settings.exists,
  };
}
