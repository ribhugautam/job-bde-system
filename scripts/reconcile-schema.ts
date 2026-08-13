import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { resolveDbTarget } from "./db-target";
import {
  fingerprintJob,
  fingerprintLead,
} from "../lib/domain/dedupe/fingerprint";

// ---------------------------------------------------------------------------
// One-time reconciliation for a database created by `drizzle-kit push`.
//
// The original deploy instructions used `db:push`, which creates tables without
// recording anything in __drizzle_migrations. The committed migration 0000 is a
// fresh CREATE TABLE baseline, so it can never apply to such a database: it
// fails on the first statement because the table already exists. The result is
// a live database stuck on an old schema while migrations report nothing to do.
//
// This script closes that gap WITHOUT dropping anything. Every operation is
// additive - ADD COLUMN, CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS
// - so no row is ever lost. It is safe to re-run.
//
//   npm run db:reconcile
//
// Fresh databases do not need this; `npm run db:migrate` handles those.
// ---------------------------------------------------------------------------

const MIGRATIONS_FOLDER = "lib/infra/db/migrations";

type ColumnSpec = { name: string; ddl: string };

/**
 * Columns added since the pushed schema. Kept explicit rather than diffed:
 * an ALTER against a live database with real rows should be reviewable at a
 * glance, and every default here is chosen so existing rows stay valid.
 */
const ADDED_COLUMNS: Record<string, ColumnSpec[]> = {
  jobs: [
    { name: "fingerprint", ddl: "text" },
    { name: "sources", ddl: "text DEFAULT '[]'" },
    { name: "description_source", ddl: "text" },
    { name: "stage", ddl: "text NOT NULL DEFAULT 'enrich'" },
    { name: "attempts", ddl: "integer NOT NULL DEFAULT 0" },
    { name: "last_error", ddl: "text" },
    { name: "next_attempt_at", ddl: "integer" },
  ],
  leads: [
    { name: "fingerprint", ddl: "text" },
    { name: "sources", ddl: "text DEFAULT '[]'" },
    { name: "stage", ddl: "text NOT NULL DEFAULT 'score'" },
    { name: "attempts", ddl: "integer NOT NULL DEFAULT 0" },
    { name: "last_error", ddl: "text" },
    { name: "next_attempt_at", ddl: "integer" },
  ],
  applications: [
    { name: "message_id", ddl: "text" },
    { name: "responded_at", ddl: "integer" },
    { name: "follow_up_count", ddl: "integer NOT NULL DEFAULT 0" },
    { name: "last_follow_up_at", ddl: "integer" },
    { name: "next_follow_up_at", ddl: "integer" },
  ],
  outreach: [
    { name: "message_id", ddl: "text" },
    { name: "responded_at", ddl: "integer" },
    { name: "follow_up_count", ddl: "integer NOT NULL DEFAULT 0" },
    { name: "last_follow_up_at", ddl: "integer" },
    { name: "next_follow_up_at", ddl: "integer" },
  ],
  digest_logs: [
    { name: "duplicates_merged", ddl: "integer DEFAULT 0" },
    { name: "jobs_enriched", ddl: "integer DEFAULT 0" },
    { name: "replies_detected", ddl: "integer DEFAULT 0" },
    { name: "follow_ups_sent", ddl: "integer DEFAULT 0" },
    { name: "budget_exhausted", ddl: "integer DEFAULT 0" },
  ],
};

function migrationSql(): string {
  const files = readdirSync(MIGRATIONS_FOLDER)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files
    .map((f) => readFileSync(join(MIGRATIONS_FOLDER, f), "utf8"))
    .join("\n");
}

function statements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Index and new-table DDL is lifted from the committed migration rather than
 * retyped here, so this script cannot drift from the schema it is reconciling
 * towards. Only `IF NOT EXISTS` is injected.
 */
function idempotent(stmt: string): string {
  return stmt
    .replace(/^CREATE TABLE\s+(?!IF NOT EXISTS)/i, "CREATE TABLE IF NOT EXISTS ")
    .replace(
      /^CREATE UNIQUE INDEX\s+(?!IF NOT EXISTS)/i,
      "CREATE UNIQUE INDEX IF NOT EXISTS "
    )
    .replace(
      /^CREATE INDEX\s+(?!IF NOT EXISTS)/i,
      "CREATE INDEX IF NOT EXISTS "
    );
}

async function tableExists(db: Client, table: string): Promise<boolean> {
  const r = await db.execute({
    sql: "select name from sqlite_master where type='table' and name = ?",
    args: [table],
  });
  return r.rows.length > 0;
}

async function columnsOf(db: Client, table: string): Promise<Set<string>> {
  const r = await db.execute(`pragma table_info(${table})`);
  return new Set(r.rows.map((row) => String(row.name)));
}

async function main() {
  const { url, authToken, label, isRemote } = resolveDbTarget();
  console.log(`Reconciling schema on ${label}\n`);

  const db = createClient({ url, authToken });
  const changes: string[] = [];
  const stageAddedFor: string[] = [];

  // --- 1. Additive columns -------------------------------------------------
  for (const [table, specs] of Object.entries(ADDED_COLUMNS)) {
    if (!(await tableExists(db, table))) {
      console.log(`- ${table}: table absent, skipping (migrate will create it)`);
      continue;
    }
    const existing = await columnsOf(db, table);
    for (const spec of specs) {
      if (existing.has(spec.name)) continue;
      await db.execute(
        `ALTER TABLE ${table} ADD COLUMN ${spec.name} ${spec.ddl}`
      );
      changes.push(`${table}.${spec.name}`);
      if (spec.name === "stage") stageAddedFor.push(table);
      console.log(`+ ${table}.${spec.name}`);
    }
  }

  // --- 2. New tables and indexes, lifted from the migration ---------------
  // The unique index on (source, source_id) is the one operation that can
  // legitimately fail: it cannot be created if the table already contains
  // duplicates. Check first so the failure is explained rather than opaque.
  for (const table of ["jobs", "leads"]) {
    if (!(await tableExists(db, table))) continue;
    const dupes = await db.execute(
      `select source, source_id, count(*) as n from ${table}
       group by source, source_id having n > 1`
    );
    if (dupes.rows.length > 0) {
      throw new Error(
        `${table} has ${dupes.rows.length} duplicate (source, source_id) pairs, ` +
          `so the unique index cannot be created. These predate the constraint. ` +
          `Remove the older row of each pair, then re-run. Example: ` +
          JSON.stringify(dupes.rows[0])
      );
    }
  }

  for (const raw of statements(migrationSql())) {
    const isIndex = /^CREATE (UNIQUE )?INDEX/i.test(raw);
    const isCacheTable = /^CREATE TABLE `?linkedin_enrich_cache`?/i.test(raw);
    if (!isIndex && !isCacheTable) continue; // never re-CREATE an existing table

    const name = raw.match(/`([^`]+)`/)?.[1] ?? "(unnamed)";

    // Check existence rather than relying on IF NOT EXISTS alone. IF NOT EXISTS
    // makes the statement safe but silent, so counting it as a change would
    // report work that did not happen — the exact failure mode that made the
    // original `drizzle-kit migrate` no-op so hard to spot.
    const present = await db.execute({
      sql: "select 1 from sqlite_master where name = ?",
      args: [name],
    });
    if (present.rows.length > 0) continue;

    try {
      await db.execute(idempotent(raw));
      console.log(`+ ${isIndex ? "index" : "table"} ${name}`);
      changes.push(name);
    } catch (err) {
      throw new Error(
        `Failed applying:\n${raw}\n\n${err instanceof Error ? err.message : err}`
      );
    }
  }

  // --- 3. Backfill --------------------------------------------------------
  // Only for tables where `stage` was added in THIS run. Re-running must never
  // reset rows that have since moved through the pipeline.
  for (const table of stageAddedFor) {
    // Pre-existing rows are history. Sending them to 'done' stops the worker
    // reprocessing them — which would otherwise draft a second cover letter for
    // every job that already has one.
    const res = await db.execute(`UPDATE ${table} SET stage = 'done'`);
    console.log(`= ${table}: ${res.rowsAffected} existing rows marked stage=done`);

    await db.execute(
      `UPDATE ${table} SET sources = json_array(source) WHERE sources IS NULL OR sources = '[]'`
    );
  }

  // Fingerprints for existing rows, so a future fetch of the same vacancy from
  // another board merges into it instead of creating a second row.
  if (stageAddedFor.includes("jobs")) {
    const rows = await db.execute(
      "select id, title, company, location, remote from jobs where fingerprint is null"
    );
    for (const r of rows.rows) {
      const fp = fingerprintJob({
        title: String(r.title ?? ""),
        company: String(r.company ?? ""),
        location: r.location == null ? undefined : String(r.location),
        remote: r.remote == null ? undefined : Boolean(r.remote),
      });
      await db.execute({
        sql: "update jobs set fingerprint = ? where id = ?",
        args: [fp, r.id as number],
      });
    }
    console.log(`= jobs: ${rows.rows.length} fingerprints backfilled`);
  }

  if (stageAddedFor.includes("leads")) {
    const rows = await db.execute(
      "select id, title, client_or_company from leads where fingerprint is null"
    );
    for (const r of rows.rows) {
      const fp = fingerprintLead({
        title: String(r.title ?? ""),
        clientOrCompany:
          r.client_or_company == null ? undefined : String(r.client_or_company),
      });
      await db.execute({
        sql: "update leads set fingerprint = ? where id = ?",
        args: [fp, r.id as number],
      });
    }
    console.log(`= leads: ${rows.rows.length} fingerprints backfilled`);
  }

  // --- 4. Stamp the migration as applied ----------------------------------
  // Otherwise the next `db:migrate` tries the CREATE TABLE baseline again and
  // fails on a database that is now fully up to date.
  const { readMigrationFiles } = await import("drizzle-orm/migrator");
  const files = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
  await db.execute(
    `CREATE TABLE IF NOT EXISTS __drizzle_migrations (
       id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric
     )`
  );
  for (const file of files) {
    const already = await db.execute({
      sql: "select 1 from __drizzle_migrations where hash = ?",
      args: [file.hash],
    });
    if (already.rows.length) continue;
    await db.execute({
      sql: "insert into __drizzle_migrations (hash, created_at) values (?, ?)",
      args: [file.hash, file.folderMillis],
    });
    console.log(`= stamped migration ${file.hash.slice(0, 12)}… as applied`);
  }

  // --- 5. Verify ----------------------------------------------------------
  const problems: string[] = [];
  for (const [table, specs] of Object.entries(ADDED_COLUMNS)) {
    if (!(await tableExists(db, table))) continue;
    const cols = await columnsOf(db, table);
    for (const spec of specs) {
      if (!cols.has(spec.name)) problems.push(`${table}.${spec.name} still missing`);
    }
  }
  if (!(await tableExists(db, "linkedin_enrich_cache"))) {
    problems.push("linkedin_enrich_cache still missing");
  }
  if (problems.length) {
    throw new Error("Reconcile finished but:\n  - " + problems.join("\n  - "));
  }

  const where = isRemote ? "the remote database" : "the local file";
  console.log(
    changes.length === 0
      ? `\nNothing to do — ${where} already matches the schema. Verified.`
      : `\nDone. ${changes.length} change(s) applied to ${where}. Schema verified.`
  );
  db.close();
}

main().catch((err) => {
  console.error("\nRECONCILE FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
