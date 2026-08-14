import { describeDbError } from "@/lib/infra/db/errors";

/**
 * Renders a database failure as something actionable.
 *
 * Every dashboard page that queries the DB wraps its load in a try/catch and
 * renders this rather than throwing. Throwing gives Next's generic
 * "This page couldn't load — a server error occurred", which in production also
 * redacts the message, so the operator gets a digest id and nothing else. For a
 * self-hosted single-user tool that is strictly worse than saying what broke.
 *
 * This is a genuine failure, so it takes --danger and the box-level treatment
 * the Settings LIVE banner uses — a tinted panel with a coloured border, not a
 * line of red text. The hint and the error chain stay greyscale so the red is
 * spent on the thing that is actually wrong.
 */
export default function DbErrorNotice({ error }: { error: unknown }) {
  const { reason, chain, hint } = describeDbError(error);

  return (
    <div className="space-y-3 rounded border border-(--danger-fg) bg-(--danger-bg) p-4 text-sm">
      <div>
        <div className="font-semibold text-(--danger-fg)">
          Couldn&apos;t read the database
        </div>
        <div className="mt-1 font-mono text-xs wrap-break-word text-(--danger-fg)">
          {reason}
        </div>
      </div>

      {hint && <p className="text-xs leading-relaxed text-(--text-muted)">{hint}</p>}

      {chain.length > 1 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-(--text-muted)">
            Full error chain ({chain.length})
          </summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-(--text-muted)">
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
