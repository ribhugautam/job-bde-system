import { getDb, schema } from "@/lib/infra/db/client";
import { count, desc, eq } from "drizzle-orm";
import Link from "next/link";
import DbErrorNotice from "@/components/DbErrorNotice";

export const dynamic = "force-dynamic";

// Counted in SQL rather than by selecting every row and reading `.length`.
// The previous version pulled the full jobs, leads, applications and outreach
// tables into memory on every page load — fine at 50 rows, a growing problem at
// 50,000, and entirely avoidable.
async function loadStats() {
  const db = getDb();
  // Note the apply-queue count comes from `jobs`, not `applications`: the queue
  // page only lists jobs that actually have a drafted letter, and counting
  // applications separately would show a number the queue does not match.
  const [[jobCount], [leadCount], [readyPitches], [queueCount], digests] =
    await Promise.all([
      db.select({ n: count() }).from(schema.jobs),
      db.select({ n: count() }).from(schema.leads),
      db
        .select({ n: count() })
        .from(schema.outreach)
        .where(eq(schema.outreach.status, "ready_for_review")),
      db
        .select({ n: count() })
        .from(schema.jobs)
        .where(eq(schema.jobs.status, "ready_for_review")),
      db
        .select()
        .from(schema.digestLogs)
        .orderBy(desc(schema.digestLogs.runAt))
        .limit(8),
    ]);

  return {
    jobs: jobCount?.n ?? 0,
    leads: leadCount?.n ?? 0,
    readyPitches: readyPitches?.n ?? 0,
    queued: queueCount?.n ?? 0,
    digests,
  };
}

function Stat({
  label,
  value,
  href,
}: {
  label: string;
  value: number | string;
  href?: string;
}) {
  const body = (
    <>
      <div className="tnum text-2xl font-semibold">{value}</div>
      <div className="text-xs text-(--text-dim)">{label}</div>
    </>
  );
  return href ? (
    <Link
      href={href}
      className="rounded border border-(--border) p-4 transition hover:border-(--border-strong)"
    >
      {body}
    </Link>
  ) : (
    <div className="rounded border border-(--border) p-4">{body}</div>
  );
}

export default async function OverviewPage() {
  // Data fetch stays in the try; the JSX below is built after it, so a render
  // error can't be mistaken for a caught DB error. Same pattern as every other
  // dashboard page (jobs, queue, applications, freelance).
  let data;
  try {
    data = await loadStats();
  } catch (err) {
    return <DbErrorNotice error={err} />;
  }

  const { jobs, leads, readyPitches, queued, digests } = data;
  const lastRun = digests[0];

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Waiting on one keystroke" value={queued} href="/dashboard/queue" />
        <Stat label="Jobs tracked" value={jobs} href="/dashboard/jobs" />
        <Stat label="Leads tracked" value={leads} href="/dashboard/freelance" />
        <Stat label="Pitches to review" value={readyPitches} href="/dashboard/freelance" />
      </div>

      <Link
        href="/dashboard/queue"
        className="block text-sm text-(--text-muted) hover:text-(--text) hover:underline"
      >
        <span className="tnum text-(--text)">{queued}</span> of{" "}
        <span className="tnum text-(--text)">{jobs}</span> jobs waiting on you
      </Link>

      {lastRun?.budgetExhausted && (
        <div className="rounded border border-(--warn-fg) bg-(--warn-bg) p-3 text-sm text-(--warn-fg)">
          The last run hit its time budget with work still queued. Nothing was
          lost — the worker resumes where it left off — but if this keeps
          happening the cron is firing too rarely for the volume. On Vercel Pro,
          change the schedule in{" "}
          <span className="font-mono text-xs">vercel.json</span> to{" "}
          <span className="font-mono text-xs">*/15 * * * *</span>.
        </div>
      )}

      <div>
        <h2 className="mb-2 text-sm font-semibold text-(--text-muted)">
          Recent runs
        </h2>
        <div className="overflow-x-auto rounded border border-(--border)">
          <table className="w-full text-left text-sm">
            <thead className="bg-(--surface) text-(--text-dim)">
              <tr>
                <th className="p-2">Run at</th>
                <th className="p-2">Jobs</th>
                <th className="p-2">Leads</th>
                <th className="p-2" title="Duplicate listings collapsed into one row">
                  Merged
                </th>
                <th className="p-2" title="LinkedIn descriptions recovered from the public page">
                  Enriched
                </th>
                <th className="p-2">Sent</th>
                <th className="p-2">Queued</th>
                <th className="p-2">Replies</th>
                <th className="p-2">Follow-ups</th>
                <th className="p-2">Notices</th>
              </tr>
            </thead>
            <tbody>
              {digests.map((d) => (
                <tr key={d.id} className="border-t border-(--border)">
                  <td className="p-2 whitespace-nowrap">
                    {d.runAt ? new Date(d.runAt).toLocaleString() : "-"}
                  </td>
                  <td className="tnum p-2">{d.newJobs}</td>
                  <td className="tnum p-2">{d.newLeads}</td>
                  <td className="tnum p-2">{d.duplicatesMerged}</td>
                  <td className="tnum p-2">{d.jobsEnriched}</td>
                  <td className="tnum p-2">
                    {(d.applicationsAutoSent ?? 0) + (d.outreachAutoSent ?? 0)}
                  </td>
                  <td className="tnum p-2">
                    {(d.applicationsQueued ?? 0) + (d.outreachQueued ?? 0)}
                  </td>
                  <td className="tnum p-2">{d.repliesDetected}</td>
                  <td className="tnum p-2">{d.followUpsSent}</td>
                  <td
                    className={
                      (d.errors as string[] | null)?.length
                        ? "tnum p-2 text-(--warn-fg)"
                        : "tnum p-2 text-(--text-faint)"
                    }
                  >
                    {(d.errors as string[] | null)?.length || 0}
                  </td>
                </tr>
              ))}
              {digests.length === 0 && (
                <tr>
                  <td className="p-4 text-(--text-dim)" colSpan={10}>
                    No runs yet. The cron fires on the schedule in vercel.json,
                    or trigger one manually — see Settings for the exact command
                    (the secret goes in the Authorization header, never a query
                    param).
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {lastRun?.summary && (
          <details className="mt-3 rounded border border-(--border) p-3">
            <summary className="cursor-pointer text-xs text-(--text-dim)">
              Last run detail
              {(lastRun.errors as string[] | null)?.length
                ? ` — ${(lastRun.errors as string[]).length} notices`
                : ""}
            </summary>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap wrap-break-word text-xs leading-relaxed text-(--text-muted)">
              {lastRun.summary}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}
