import { existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Resolves which database a CLI script should talk to, and says so out loud.
//
// This exists because of a real incident. `tsx` does not load `.env`, so
// `npm run db:migrate` quietly targeted the local SQLite fallback while the
// operator believed it was migrating Turso. Everything reported success, and
// the remote database silently kept an old schema until the dashboard started
// failing on missing columns.
//
// Two defences, both here:
//   1. Load .env explicitly, so the scripts see the same config the app does.
//   2. Print the resolved target before doing anything, so "local" vs "remote"
//      is never an assumption.
// ---------------------------------------------------------------------------

export type DbTarget = {
  url: string;
  authToken?: string;
  isRemote: boolean;
  label: string;
};

export function resolveDbTarget(): DbTarget {
  // Node 22 built-in; no dotenv dependency needed. Real env vars already
  // present (CI, Vercel) win, because loadEnvFile does not overwrite them.
  if (existsSync(".env")) {
    try {
      process.loadEnvFile(".env");
    } catch {
      // A malformed .env should not be fatal when the real environment already
      // carries what we need — the validation below is what actually gates us.
    }
  }

  const url = process.env.TURSO_DATABASE_URL?.trim() || "file:./local.db";
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim() || undefined;
  const isRemote = !url.startsWith("file:");

  if (isRemote && !authToken) {
    throw new Error(
      "TURSO_AUTH_TOKEN is not set but TURSO_DATABASE_URL points at a remote " +
        "database. Run `turso db tokens create <db-name>`."
    );
  }

  // Never print the token, and never print the full URL of a remote database —
  // it carries the org/db identifiers. Host is enough to tell them apart.
  const label = isRemote
    ? `REMOTE Turso (${safeHost(url)})`
    : `LOCAL file (${url})`;

  return { url, authToken, isRemote, label };
}

function safeHost(url: string): string {
  try {
    return new URL(url.replace(/^libsql:/, "https:")).host;
  } catch {
    return "unknown host";
  }
}
