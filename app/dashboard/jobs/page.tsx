import Link from "next/link";
import { getDb } from "@/lib/infra/db/client";
import { getSettings } from "@/lib/infra/db/settings";
import { requireUser } from "@/lib/infra/session";
import { getProfile } from "@/lib/infra/db/profiles";
import { touchLastSeen } from "@/lib/infra/db/users";
import { parseJobView, serializeJobView } from "@/lib/domain/jobs/filters";
import { fetchRankedJobs, MAX_RANKED_ROWS } from "@/lib/infra/db/job-queries";
import BucketBar from "@/components/jobs/BucketBar";
import JobRow from "@/components/jobs/JobRow";
import {
  DismissButton,
  JobStatusSelect,
  KeepButton,
} from "@/components/jobs/JobControls";
import DbErrorNotice from "@/components/DbErrorNotice";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

export default async function JobsPage({ searchParams }: PageProps<"/dashboard/jobs">) {
  const user = await requireUser("/dashboard/jobs");

  // Next 16 delivers searchParams as a promise.
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) value.forEach((v) => params.append(key, v));
    else if (value !== undefined) params.append(key, value);
  }
  const view = parseJobView(params);

  // JSX construction stays out of the try: React defers rendering, so a
  // try/catch around a returned JSX tree would not catch render errors — only
  // the data fetch belongs in here. Same pattern as every other dashboard page.
  let data;
  try {
    const settings = await getSettings();
    const db = getDb();
    const profile = await getProfile(user.id);
    const ranked = await fetchRankedJobs({
      db,
      userId: user.id,
      view,
      profile,
      staleDays: settings.JOB_STALE_DAYS,
      pageSize: PAGE_SIZE,
      // Read BEFORE it is advanced below, so "new since you last looked" means
      // since the PREVIOUS visit rather than since a moment ago.
      lastSeenAt: user.lastSeenAt,
    });
    data = { ranked, staleDays: settings.JOB_STALE_DAYS };
  } catch (err) {
    return <DbErrorNotice error={err} />;
  }

  const { ranked, staleDays } = data;

  // Advanced only now that the markers for THIS render are computed, and only
  // on the jobs page rather than in the dashboard layout — updating it on every
  // navigation would zero the marker before it was ever seen. Fire-and-forget:
  // a failed write here must never break the page.
  void touchLastSeen(user.id);

  const pageCount = Math.max(1, Math.ceil(ranked.total / PAGE_SIZE));
  const pageHref = (page: number) => {
    const qs = serializeJobView({ ...view, page }).toString();
    return qs ? `/dashboard/jobs?${qs}` : "/dashboard/jobs";
  };

  return (
    <div className="-mx-6 -my-6">
      <BucketBar
        view={view}
        counts={ranked.counts}
        shown={ranked.rows.length}
        total={ranked.total}
        staleDays={staleDays}
        newCount={ranked.rows.filter((r) => r.isNew).length}
      />

      {ranked.truncated && (
        <p className="border-b border-(--warn-fg) bg-(--warn-bg) px-3 py-2 text-[11px] text-(--warn-fg)">
          More than {MAX_RANKED_ROWS.toLocaleString()} jobs match this view. Only
          the most recent were ranked, so this list is not the complete picture —
          narrow it with the search box, or lower JOB_STALE_DAYS.
        </p>
      )}

      <div>
        {ranked.rows.map((row) => (
          // The wrapper repeats the row's hover tint so the control group below
          // can sit on the same colour. Without it the row's own hover
          // background drops the moment the pointer moves onto the overlay —
          // the overlay is a sibling of the row, not a child of it.
          <div
            key={row.job.id}
            className="group relative hover:bg-(--surface-hover)"
          >
            <JobRow ranked={row} />
            {/*
              The hover-revealed control group. Solid background and horizontal
              padding because it lands on top of the row's source column, which
              sits at the same right edge in the same 11px type: without one
              they overlapped into unreadable mush at xl and wider. min-h-full
              keeps it the height of the row and lets it grow downward rather
              than clip when a control renders an error.
            */}
            <div className="absolute right-1 top-0 flex min-h-full items-center gap-2 rounded bg-(--surface-hover) px-2 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
              <JobStatusSelect jobId={row.job.id} status={row.userStatus} />
              {/* Keep is offered only where it means something: a job already
                  in Working is there BECAUSE its status says so. */}
              {view.bucket === "inbox" && <KeepButton jobId={row.job.id} />}
              <DismissButton
                jobId={row.job.id}
                dismissed={row.userStatus === "ignored"}
              />
            </div>
          </div>
        ))}

        {ranked.rows.length === 0 && (
          <p className="px-3 py-6 text-sm text-(--text-dim)">
            {view.query
              ? `Nothing in ${view.bucket} matches “${view.query}”.`
              : view.bucket === "inbox"
                ? "Inbox is clear. New jobs arrive with the next pipeline run."
                : `Nothing in ${view.bucket} yet.`}
          </p>
        )}
      </div>

      {pageCount > 1 && (
        <div className="flex items-center gap-3 px-3 py-3 text-[11px] text-(--text-muted)">
          {view.page > 1 && (
            <Link href={pageHref(view.page - 1)} className="hover:text-(--text)">
              ← previous
            </Link>
          )}
          <span className="tnum text-(--text-faint)">
            page {view.page} of {pageCount}
          </span>
          {view.page < pageCount && (
            <Link href={pageHref(view.page + 1)} className="hover:text-(--text)">
              next →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
