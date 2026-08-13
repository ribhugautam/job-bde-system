import { getDb, schema } from "@/lib/db/client";
import { desc } from "drizzle-orm";
import StatusBadge from "@/components/StatusBadge";
import { StatusSelect } from "@/components/ActionButtons";

export const dynamic = "force-dynamic";

const JOB_STATUSES = [
  "found", "matched", "ready_for_review", "sent", "responded",
  "interview", "offer", "rejected", "ignored",
];

export default async function JobsPage() {
  const db = getDb();
  const jobs = await db.select().from(schema.jobs).orderBy(desc(schema.jobs.score)).limit(200);

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-neutral-300">
        {jobs.length} jobs, ranked by fit score
      </h2>
      <div className="space-y-2">
        {jobs.map((job) => (
          <div key={job.id} className="rounded border border-neutral-800 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <a
                  href={job.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-white hover:underline"
                >
                  {job.title}
                </a>
                <div className="text-xs text-neutral-400">
                  {job.company} · {job.location} · {job.source}
                  {job.salaryText ? ` · ${job.salaryText}` : ""}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-neutral-400">score {job.score}</span>
                <StatusBadge status={job.status} />
                <StatusSelect entity="job" id={job.id} status={job.status} options={JOB_STATUSES} />
              </div>
            </div>
            {job.scoreReasons && (job.scoreReasons as string[]).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {(job.scoreReasons as string[]).map((r, i) => (
                  <span key={i} className="rounded bg-neutral-900 px-1.5 py-0.5 text-[10px] text-neutral-400">
                    {r}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
        {jobs.length === 0 && (
          <p className="text-sm text-neutral-500">
            No jobs yet - wait for the first daily cron run, or trigger one manually.
          </p>
        )}
      </div>
    </div>
  );
}
