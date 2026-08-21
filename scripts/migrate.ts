// Applies committed migrations from lib/infra/db/migrations.
//
// This uses drizzle-orm's programmatic migrator rather than `drizzle-kit
// migrate`, for two reasons:
//
//   1. The CLI silently no-ops against a `file:` URL under this config — it
//      exits 0, prints a spinner, and creates nothing. A migration tool that
//      reports success without doing anything is worse than one that fails,
//      because the failure only surfaces later as "no such table".
//   2. This path builds its client exactly the way the app does, so there is
//      one source of truth for how a database URL and token become a
//      connection. The CLI reading drizzle.config.ts was a second one that
//      could drift.
//
// Safe to re-run: the migrator records applied migrations in
// `__drizzle_migrations` and skips them.
//
//   npm run db:migrate
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { resolveDbTarget } from "./db-target";
import {
  claimOrphanedRecords,
  ensureFirstAdmin,
} from "../lib/infra/db/seed-admin";
import { seedSettingsFromEnv } from "../lib/infra/db/settings";

const MIGRATIONS_FOLDER = "lib/infra/db/migrations";

async function main() {
  // resolveDbTarget loads .env itself. tsx does not, and the first version of
  // this script therefore migrated the local fallback while reporting success,
  // leaving the remote database on an old schema.
  const { url, authToken, label } = resolveDbTarget();
  console.log(`Applying migrations from ${MIGRATIONS_FOLDER} to ${label}`);

  const client = createClient({ url, authToken });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  // Verified rather than assumed. The whole reason this script exists is that
  // the tool it replaced claimed success while doing nothing, so it ends by
  // reading the schema back.
  const result = await client.execute(
    "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name"
  );
  const tables = result.rows.map((r) => String(r.name));
  if (tables.length === 0) {
    throw new Error(
      "Migrations reported success but the database has no tables. " +
        "Check that " + MIGRATIONS_FOLDER + " contains SQL and a meta/_journal.json."
    );
  }

  console.log(`Done. ${tables.length} tables: ${tables.join(", ")}`);

  // Seeding the first admin is part of migrating, not a separate step somebody
  // has to remember. The migration that creates `users` is the exact moment the
  // app stops accepting APP_PASSWORD and starts requiring an account, so a
  // deployment that migrated and did not seed is one nobody can log into — and
  // registration is invite-only, so there would be nobody to issue the first
  // invite either. See lib/infra/db/seed-admin.ts.
  const seeded = await ensureFirstAdmin();
  if (seeded.created) {
    console.log(
      `Created the first admin account: ${seeded.email}\n` +
        `  Sign in with APP_PASSWORD, then change it from the dashboard.`
    );
  } else {
    console.log(`First-admin seed skipped: ${seeded.reason}`);
  }

  // Rows written before accounts existed have no owner. Assigning them is part
  // of migrating, not an optional cleanup -- an unowned resume is invisible to
  // every read path, since those are all scoped to a user by design.
  const claimed = await claimOrphanedRecords();
  const total = claimed.documents + claimed.applications + claimed.outreach;
  if (total > 0) {
    console.log(
      `Assigned pre-accounts rows to the owner: ${claimed.documents} document(s), ` +
        `${claimed.applications} application(s), ${claimed.outreach} outreach.`
    );
  }

  // Seeding settings is load-bearing, not tidy-up. Operational config moved out
  // of env into a database row; without this seed every one of those values
  // silently reverts to its schema default on the next deploy -- including
  // MATCH_THRESHOLD, which changes what gets drafted and sent. Idempotent, and
  // it only ever writes into an absent row, so re-running it cannot drag an
  // admin's tuning back to whatever the environment still says.
  const settings = await seedSettingsFromEnv();
  if (settings.seeded) {
    console.log(
      settings.from.length
        ? `Seeded runtime settings from ${settings.from.length} env var(s): ${settings.from.join(", ")}.
` +
            `  Those variables are now ignored -- manage these under Settings.`
        : "Seeded runtime settings with defaults (no matching env vars were set)."
    );
  } else {
    console.log(`Settings seed skipped: ${settings.reason}`);
  }

  client.close();
}

main().catch((err) => {
  console.error("MIGRATION FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
