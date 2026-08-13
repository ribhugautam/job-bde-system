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

const MIGRATIONS_FOLDER = "lib/infra/db/migrations";

async function main() {
  const url = process.env.TURSO_DATABASE_URL ?? "file:./local.db";
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url.startsWith("file:") && !authToken) {
    throw new Error(
      "TURSO_AUTH_TOKEN is not set but TURSO_DATABASE_URL points at a remote " +
        "database. Run `turso db tokens create <db-name>`."
    );
  }

  const target = url.startsWith("file:") ? `${url} (local)` : "Turso (remote)";
  console.log(`Applying migrations from ${MIGRATIONS_FOLDER} to ${target}`);

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
  client.close();
}

main().catch((err) => {
  console.error("MIGRATION FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
