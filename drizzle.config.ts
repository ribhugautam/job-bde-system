import type { Config } from "drizzle-kit";

// Mirrors lib/infra/db/client.ts: no env vars -> local SQLite file;
// TURSO_DATABASE_URL set -> remote Turso. drizzle-kit needs the "turso" dialect
// for the remote case and plain "sqlite" for a local file.
//
// Note this file reads process.env directly rather than going through
// lib/config/env.ts. drizzle-kit loads it outside the app runtime, where the
// full env (APP_PASSWORD, AUTH_SECRET, ...) is neither present nor relevant;
// validating it here would make `db:generate` fail on a machine that only has
// database credentials.
const url = process.env.TURSO_DATABASE_URL ?? "file:./local.db";
const isLocalFile = url.startsWith("file:");

const SCHEMA = "./lib/infra/db/schema.ts";
const OUT = "./lib/infra/db/migrations";

export default (
  isLocalFile
    ? {
        schema: SCHEMA,
        out: OUT,
        dialect: "sqlite",
        dbCredentials: { url },
      }
    : {
        schema: SCHEMA,
        out: OUT,
        dialect: "turso",
        dbCredentials: { url, authToken: process.env.TURSO_AUTH_TOKEN! },
      }
) satisfies Config;
