import { getDb } from "@/lib/infra/db/client";
import { parseJobFilters } from "@/lib/domain/jobs/filters";
import { fetchFilteredJobs, fetchJobSources } from "@/lib/infra/db/job-queries";
import { JOB_STATUSES } from "@/lib/pipeline/state";
import FilterBar from "@/components/jobs/FilterBar";
import JobRow from "@/components/jobs/JobRow";
import DismissButton from "@/components/jobs/DismissButton";
import { StatusSelect } from "@/components/ActionButtons";
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
  // every other dashboard page (queue, applications, freelance, resume).
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
          // The wrapper repeats the row's hover tint so the control group below
          // can sit on the same colour. Without it the row's own hover
          // background drops the moment the pointer moves onto the overlay —
          // the overlay is a sibling of the row, not a child of it.
          <div key={job.id} className="group relative hover:bg-(--surface-hover)">
            <JobRow job={job} />
            {/*
              The hover-revealed control group. It has a solid background and
              horizontal padding because it lands on top of the row's source
              column, which sits at the same right edge in the same 11px type:
              without one they overlapped into unreadable mush at xl and wider.
              min-h-full keeps it the height of the row, and lets it grow
              downward rather than clip when a control renders an error.
            */}
            <div className="absolute right-1 top-0 flex min-h-full items-center gap-2 rounded bg-(--surface-hover) px-2 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
              {/*
                Ungated, unlike dismiss: setting any status is the point. Six of
                the eleven in JOB_STATUSES — matched, rejected, responded,
                interview, offer, closed — are reachable from nowhere else in
                the UI, since mark-applied only toggles ready_for_review ⇄ sent
                and dismiss only toggles found ⇄ ignored. The list comes from
                lib/pipeline/state.ts; a local copy here is what drifted last
                time.
              */}
              <StatusSelect
                entity="job"
                id={job.id}
                status={job.status}
                options={[...JOB_STATUSES]}
              />
              {/*
                Only `found` and `ignored` get dismiss: dismiss/restore is a
                lossless round trip only between those two statuses. Restore
                hardcodes the target status to `found`, and storing where a job
                actually was is off the table (no schema change) — so a job that
                has moved past `found` (e.g. ready_for_review, matched) must not
                be offered dismiss at all, or restoring it would silently drop
                it out of whatever queue tracks that status.
              */}
              {(job.status === "found" || job.status === "ignored") && (
                <DismissButton jobId={job.id} dismissed={job.status === "ignored"} />
              )}
            </div>
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
