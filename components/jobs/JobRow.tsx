import Chip from "@/components/ui/Chip";
import { jobFactChips } from "./factChips";
import type { jobs } from "@/lib/infra/db/schema";

type Job = typeof jobs.$inferSelect;

/**
 * One line per job.
 *
 * Fixed row height is the point: the list is scanned, not read. The title
 * truncates rather than wrapping so the eye can run down the score column and
 * the chip column without the rows jittering.
 */
export default function JobRow({ job }: { job: Job }) {
  const chips = jobFactChips(job);
  const dismissed = job.status === "ignored";

  return (
    <div
      className={`flex items-baseline gap-3 border-b border-(--border) px-3 py-2 hover:bg-(--surface-hover) ${
        dismissed ? "opacity-40" : ""
      }`}
    >
      <span className="tnum w-8 shrink-0 text-right text-xs font-semibold text-(--text)">
        {job.score ?? 0}
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
