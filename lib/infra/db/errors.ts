// ---------------------------------------------------------------------------
// Turning a database error into something an operator can act on.
//
// Written after a real incident. The dashboard rendered:
//
//   Failed query: select "id", "run_at", ... from "digest_logs" ... params: 8
//
// which is DrizzleQueryError.message — the SQL, but not the reason. The actual
// cause ("no such column: duplicates_merged") sits in `.cause`, one or two
// levels down, and was never shown. Reading the query taught you nothing you
// did not already know; the one sentence that would have identified the problem
// in seconds was the one being dropped.
// ---------------------------------------------------------------------------

/** Walks the `cause` chain and returns each distinct message, outermost first. */
export function errorChain(err: unknown, limit = 5): string[] {
  const out: string[] = [];
  let current: unknown = err;
  for (let i = 0; i < limit && current; i++) {
    const message =
      current instanceof Error ? current.message : String(current);
    const trimmed = message.trim();
    // Skip repeats: libSQL wraps the same text several times.
    if (trimmed && !out.some((m) => m === trimmed || m.includes(trimmed))) {
      out.push(trimmed);
    }
    current =
      current instanceof Error && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return out;
}

export type DbErrorDescription = {
  /** The most specific message found — usually the real reason. */
  reason: string;
  /** Full outermost-to-innermost chain, for display under a details toggle. */
  chain: string[];
  /** Actionable next step when the shape of the error is recognised. */
  hint?: string;
};

const SCHEMA_HINT =
  "The database is reachable but its schema is out of date — it is missing a " +
  "table or column this build expects. This happens when the database was " +
  "created with `drizzle-kit push` (which records no migration history) and " +
  "then the schema changed. Run `npm run db:reconcile` with the same " +
  "TURSO_DATABASE_URL to add what is missing without dropping anything.";

export function describeDbError(err: unknown): DbErrorDescription {
  const chain = errorChain(err);

  // The innermost message is the specific one; the outer layers are wrappers
  // restating the query. Prefer a link in the chain that names a cause.
  const specific =
    chain.find((m) => /no such (table|column)|SQLITE_|UNIQUE constraint/i.test(m)) ??
    chain[chain.length - 1] ??
    "Unknown database error";

  let hint: string | undefined;
  if (/no such (table|column)/i.test(specific)) {
    hint = SCHEMA_HINT;
  } else if (/unauthorized|401|invalid token|jwt/i.test(specific)) {
    hint =
      "The database rejected the credentials. Check TURSO_AUTH_TOKEN matches " +
      "TURSO_DATABASE_URL, and that the token has not been revoked.";
  } else if (/ENOTFOUND|ECONNREFUSED|fetch failed|network/i.test(specific)) {
    hint =
      "Could not reach the database host. Check TURSO_DATABASE_URL, and that " +
      "the Turso database has not been deleted or paused.";
  }

  return { reason: specific, chain, hint };
}
