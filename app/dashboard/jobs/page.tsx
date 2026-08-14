import { getDb } from "@/lib/infra/db/client";
import { parseJobFilters } from "@/lib/domain/jobs/filters";
import { fetchFilteredJobs, fetchJobSources } from "@/lib/infra/db/job-queries";
import FilterBar from "@/components/jobs/FilterBar";
import JobRow from "@/components/jobs/JobRow";
import DismissButton from "@/components/jobs/DismissButton";
import DbErrorNotice from "@/components/DbErrorNotice";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 200;

export default async function JobsPage({ searchParams }: PageProps<"/dashboard/jobs">) {
  // Next 16 delivers searchParams as a promise.
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) value.forEach((v) => params.append(key, v));
    else if (value !== undefined) params.append(key, value);
  }
  const filters = parseJobFilters(params);

  // JSX construction stays out of the try: React defers rendering, so a
  // try/catch around a `return (<jsx/>)` would not actually catch render
  // errors — only the data fetch belongs in here. See the same pattern in
  // every other dashboard page (queue, applications, leads, outreach).
  let jobsData;
  try {
    const db = getDb();
    const [{ rows, total }, sources] = await Promise.all([
      fetchFilteredJobs(db, filters, PAGE_SIZE),
      fetchJobSources(db),
    ]);
    jobsData = { rows, total, sources };
  } catch (err) {
    return <DbErrorNotice error={err} />;
  }

  const { rows, total, sources } = jobsData;

  return (
    <div className="-mx-6 -my-6">
      <FilterBar
        filters={filters}
        total={total}
        shown={rows.length}
        sources={sources}
      />
      <div>
        {rows.map((job) => (
          <div key={job.id} className="group relative">
            <JobRow job={job} />
            <span className="absolute right-3 top-2 hidden group-hover:block">
              <DismissButton jobId={job.id} dismissed={job.status === "ignored"} />
            </span>
          </div>
        ))}
        {rows.length === 0 && (
          <p className="px-3 py-6 text-sm text-(--text-dim)">
            No jobs match these filters.
          </p>
        )}
      </div>
    </div>
  );
}
