import { describeDbError } from "@/lib/infra/db/errors";

/**
 * Renders a database failure as something actionable.
 *
 * Every dashboard page that queries the DB wraps its load in a try/catch and
 * renders this rather than throwing. Throwing gives Next's generic
 * "This page couldn't load — a server error occurred", which in production also
 * redacts the message, so the operator gets a digest id and nothing else. For a
 * self-hosted single-user tool that is strictly worse than saying what broke.
 */
export default function DbErrorNotice({ error }: { error: unknown }) {
  const { reason, chain, hint } = describeDbError(error);

  return (
    <div className="space-y-3 rounded border border-red-900 bg-red-950/40 p-4 text-sm text-red-200">
      <div>
        <div className="font-semibold">Couldn&apos;t read the database</div>
        <div className="mt-1 font-mono text-xs wrap-break-word text-red-300">
          {reason}
        </div>
      </div>

      {hint && <p className="text-xs leading-relaxed text-red-100/80">{hint}</p>}

      {chain.length > 1 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-red-300/70">
            Full error chain ({chain.length})
          </summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-red-300/70">
            {chain.map((m, i) => (
              <li key={i} className="font-mono wrap-break-word">
                {m}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
