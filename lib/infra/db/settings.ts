import { eq } from "drizzle-orm";
import { getDb, schema } from "./client";
import {
  SETTING_KEYS,
  defaultSettings,
  parseSettings,
  validateSettings,
  type Settings,
} from "@/lib/config/settings";

// ---------------------------------------------------------------------------
// Reading and writing the settings row.
//
// getSettings() ALWAYS returns a usable Settings — never null, never a throw.
// Every page and every pipeline run depends on it, so a missing or corrupted
// row has to degrade to defaults rather than take down the dashboard an admin
// would use to repair it.
// ---------------------------------------------------------------------------

/** The singleton row id. See the note on app_settings in schema.ts. */
const ROW_ID = 1;

export type StoredSettings = Settings & {
  updatedAt: Date | null;
  updatedByUserId: number | null;
  /** False when no row exists yet and these are pure defaults. */
  exists: boolean;
};

export async function getSettings(): Promise<StoredSettings> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.appSettings)
    .where(eq(schema.appSettings.id, ROW_ID))
    .limit(1);

  if (!row) {
    return {
      ...defaultSettings(),
      updatedAt: null,
      updatedByUserId: null,
      exists: false,
    };
  }

  return {
    ...parseSettings(row.values),
    updatedAt: row.updatedAt,
    updatedByUserId: row.updatedByUserId,
    exists: true,
  };
}

export type SaveSettingsResult = { ok: true } | { ok: false; errors: string[] };

/**
 * Writes the settings row.
 *
 * Cross-field rules are enforced HERE and not on read: a stored row that
 * violates them must still load, or the settings page could not render to fix
 * it. Writes are the right place to refuse.
 */
export async function saveSettings(
  input: unknown,
  updatedByUserId: number
): Promise<SaveSettingsResult> {
  // Total parse first, so out-of-range numbers are clamped to their bounds
  // rather than rejected — then the cross-field rules run on the real values
  // that would be stored, not on what was submitted.
  const settings = parseSettings(input);

  const errors = validateSettings(settings);
  if (errors.length) return { ok: false, errors };

  const db = getDb();
  const values = {
    id: ROW_ID,
    values: settings as unknown as Record<string, unknown>,
    updatedByUserId,
    updatedAt: new Date(),
  };

  await db
    .insert(schema.appSettings)
    .values(values)
    .onConflictDoUpdate({ target: schema.appSettings.id, set: values });

  return { ok: true };
}

/**
 * Creates the settings row from the CURRENT environment, once.
 *
 * The load-bearing step of this migration. Without it every moved setting
 * silently reverts to its schema default on deploy — including MATCH_THRESHOLD,
 * which would quietly change what gets drafted and sent. Seeding from env means
 * behaviour is identical the moment the migration finishes.
 *
 * Idempotent, and it only ever writes into an ABSENT row: re-running it after
 * an admin has tuned something must not drag those values back to whatever the
 * environment still happens to say.
 */
export async function seedSettingsFromEnv(): Promise<
  { seeded: true; from: string[] } | { seeded: false; reason: string }
> {
  const db = getDb();
  const [existing] = await db
    .select({ id: schema.appSettings.id })
    .from(schema.appSettings)
    .where(eq(schema.appSettings.id, ROW_ID))
    .limit(1);

  if (existing) {
    return { seeded: false, reason: "settings already exist; leaving them alone" };
  }

  // Read the raw environment rather than lib/config/env.ts: that module has
  // already had these keys removed, which is the point of this migration. This
  // is the one place the old names are still consulted.
  const raw: Record<string, unknown> = {};
  const from: string[] = [];

  for (const key of SETTING_KEYS) {
    const value = process.env[key];
    if (value === undefined || value.trim() === "") continue;

    raw[key] = coerce(key, value.trim());
    from.push(key);
  }

  await db.insert(schema.appSettings).values({
    id: ROW_ID,
    // parseSettings fills every key that env did not supply with its default,
    // so the stored row is always complete.
    values: parseSettings(raw) as unknown as Record<string, unknown>,
    updatedByUserId: null,
    updatedAt: new Date(),
  });

  return { seeded: true, from };
}

/**
 * Environment variables are strings; the settings schema expects real booleans
 * and numbers. Mirrors the coercion lib/config/env.ts used to do for these keys,
 * so a deployment's existing values carry over meaning exactly what they did.
 */
function coerce(key: keyof Settings, value: string): unknown {
  if (key.startsWith("ENABLE_") || key === "DRY_RUN") {
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  }
  if (key === "IMAP_HOST" || key === "IMAP_MAILBOX") return value;
  const asNumber = Number(value);
  return Number.isFinite(asNumber) ? asNumber : undefined;
}

/**
 * Moved variables that are STILL set in the environment, where they now do
 * nothing.
 *
 * Surfaced in the settings UI on purpose. Otherwise somebody raises
 * MATCH_THRESHOLD in Vercel, redeploys, watches nothing change, and loses an
 * afternoon — the same failure the auth 503 page already goes out of its way to
 * prevent by naming the exact variable at fault.
 */
export function inertEnvVars(): string[] {
  return SETTING_KEYS.filter((key) => {
    const value = process.env[key];
    return value !== undefined && value.trim() !== "";
  });
}
