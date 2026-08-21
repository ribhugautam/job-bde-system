import Chip from "@/components/ui/Chip";
import StatusBadge from "@/components/StatusBadge";
import { jobFactChips } from "./factChips";
import type { RankedJob } from "@/lib/infra/db/job-queries";

/**
 * One line per job.
 *
 * Fixed row height is the point: the list is scanned, not read. The title
 * truncates rather than wrapping so the eye can run down the score column and
 * the chip column without the rows jittering.
 *
 * The score and status shown are THIS VIEWER'S, not the row's. `jobs.score` and
 * `jobs.status` still exist and still belong to the shared pipeline, but they
 * are the wrong numbers to put in front of a person now that ranking is
 * per-profile — two colleagues looking at the same row should, and do, see
 * different scores.
 */
export default function JobRow({ ranked }: { ranked: RankedJob }) {
  const { job, score, userStatus, isNew, archivedBecause } = ranked;
  const dimmed = archivedBecause !== null;
  const chips = jobFactChips(job);

  return (
    <div
      className={`flex items-baseline gap-3 border-b border-(--border) px-3 py-2 hover:bg-(--surface-hover) ${
        dimmed ? "opacity-40" : ""
      }`}
    >
      <span className="tnum w-8 shrink-0 text-right text-xs font-semibold text-(--text)">
        {score}
      </span>

      {/* A dot rather than a "NEW" badge: it has to survive being repeated down
          a long list without turning the column into noise. */}
      <span className="w-2 shrink-0">
        {isNew && (
          <span
            title="Arrived since you last looked"
            className="block h-1.5 w-1.5 rounded-full bg-(--info-fg)"
          />
        )}
      </span>

      <a
        href={job.url}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 flex-1 truncate text-[13px] text-(--text) hover:underline"
      >
        <span className="font-semibold">{job.title}</span>
        <span className="text-(--text-muted)"> · {job.company}</span>
      </a>

      {job.salaryText && (
        <span className="hidden shrink-0 text-[11px] text-(--text-dim) lg:inline">
          {job.salaryText}
        </span>
      )}

      {/* Why it is in the archive, because "I gave up on this" and "this timed
          out before I looked" call for completely different follow-up. */}
      {archivedBecause === "expired" && (
        <span className="hidden shrink-0 text-[11px] text-(--text-faint) md:inline">
          expired
        </span>
      )}

      {userStatus && userStatus !== "found" && (
        <span className="hidden shrink-0 md:inline">
          <StatusBadge status={userStatus} />
        </span>
      )}

      <span className="flex shrink-0 gap-1">
        {chips.map((chip) => (
          <Chip key={chip.label} tone={chip.tone}>
            {chip.label}
          </Chip>
        ))}
      </span>

      <span className="hidden w-24 shrink-0 truncate text-right text-[11px] text-(--text-faint) xl:inline">
        {job.source}
      </span>
    </div>
  );
}
