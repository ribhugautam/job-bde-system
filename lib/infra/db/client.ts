import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import * as schema from "./schema";

// libSQL (Turso) is SQLite. Two modes, same code:
//   - dev  : no env vars set -> a real local SQLite file at ./local.db
//   - prod : TURSO_DATABASE_URL + TURSO_AUTH_TOKEN -> Turso over HTTP
//
// The HTTP driver is stateless, so unlike node-postgres there is no connection
// pool to exhaust when Vercel cold-starts many lambdas at once.

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (_db) return _db;

  const url = process.env.TURSO_DATABASE_URL ?? "file:./local.db";
  const authToken = process.env.TURSO_AUTH_TOKEN;

  // A remote Turso URL without a token fails at query time with an opaque
  // error, so fail loudly here instead.
  if (!url.startsWith("file:") && !authToken) {
    throw new Error(
      "TURSO_AUTH_TOKEN is not set but TURSO_DATABASE_URL points at a remote " +
        "database. Run `turso db tokens create <db-name>` and add it to your " +
        "Vercel project's environment variables."
    );
  }

  const client = createClient({ url, authToken });
  _db = drizzle(client, { schema });
  return _db;
}

export { schema };
