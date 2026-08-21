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
  claimOrphanedDocuments,
  ensureFirstAdmin,
} from "../lib/infra/db/seed-admin";

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
  const claimed = await claimOrphanedDocuments();
  if (claimed > 0) {
    console.log(`Assigned ${claimed} pre-accounts document(s) to the owner.`);
  }

  client.close();
}

main().catch((err) => {
  console.error("MIGRATION FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
