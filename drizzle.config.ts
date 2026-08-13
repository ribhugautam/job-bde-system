import type { Config } from "drizzle-kit";

// Mirrors lib/db/client.ts: no env vars -> local SQLite file; TURSO_DATABASE_URL
// set -> remote Turso. drizzle-kit needs the "turso" dialect for the remote case
// and plain "sqlite" for a local file.
const url = process.env.TURSO_DATABASE_URL ?? "file:./local.db";
const isLocalFile = url.startsWith("file:");

export default (
  isLocalFile
    ? {
        schema: "./lib/db/schema.ts",
        out: "./drizzle",
        dialect: "sqlite",
        dbCredentials: { url },
      }
    : {
        schema: "./lib/db/schema.ts",
        out: "./drizzle",
        dialect: "turso",
        dbCredentials: { url, authToken: process.env.TURSO_AUTH_TOKEN! },
      }
) satisfies Config;
