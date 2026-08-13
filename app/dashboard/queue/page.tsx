import { desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/lib/infra/db/client";
import ApplyQueue, { type QueueItem } from "@/components/ApplyQueue";

export const dynamic = "force-dynamic";

/**
 * The assisted-apply queue: everything the pipeline scored and drafted but
 * could not send itself, because the listing publishes no apply-by-email
 * address (LinkedIn and most company portals).
 */
export default async function QueuePage() {
  const db = getDb();

  const jobs = await db
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.status, "ready_for_review"))
    .orderBy(desc(schema.jobs.score))
    .limit(100);

  // One query for every application rather than one per job. The previous
  // pipeline's per-row lookups were the main source of latency against Turso's
  // stateless HTTP driver, and a page that fans out 100 round-trips would
  // reintroduce exactly that.
  const jobIds = jobs.map((j) => j.id);
  const apps = jobIds.length
    ? await db
        .select()
        .from(schema.applications)
        .where(inArray(schema.applications.jobId, jobIds))
    : [];

  // Keep the newest draft per job — a re-drafted application should supersede
  // the earlier attempt rather than show up twice.
  const latestByJob = new Map<number, (typeof apps)[number]>();
  for (const app of apps) {
    const existing = latestByJob.get(app.jobId);
    if (!existing || app.id > existing.id) latestByJob.set(app.jobId, app);
  }

  const items: QueueItem[] = jobs
    .map((job) => {
      const app = latestByJob.get(job.id);
      // A job with no drafted letter has nothing to copy, so it does not belong
      // in a queue whose whole promise is "the letter is already written".
      if (!app) return null;
      return {
        jobId: job.id,
        title: job.title,
        company: job.company,
        location: job.location,
        source: job.source,
        url: job.url,
        score: job.score ?? 0,
        salaryText: job.salaryText,
        coverLetter: app.coverLetter,
        scoreReasons: (job.scoreReasons as string[]) ?? [],
      } satisfies QueueItem;
    })
    .filter((x): x is QueueItem => x !== null);

  const missingDrafts = jobs.length - items.length;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-neutral-300">
          Apply queue — {items.length} ready
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          Scored, drafted, and waiting on one keystroke. Anything with a
          published apply-by-email address was sent automatically and never
          reaches this list.
        </p>
        {missingDrafts > 0 && (
          <p className="mt-1 text-xs text-amber-400">
            {missingDrafts} matched{" "}
            {missingDrafts === 1 ? "job is" : "jobs are"} hidden here because no
            cover letter was drafted yet — they are still queued in the pipeline
            and will appear after the next run.
          </p>
        )}
      </div>
      <ApplyQueue items={items} />
    </div>
  );
}
