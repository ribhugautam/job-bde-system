import { getDb, schema } from "@/lib/db/client";
import { desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

async function loadStats() {
  const db = getDb();
  const [jobs, leads, apps, pitches, digests] = await Promise.all([
    db.select().from(schema.jobs),
    db.select().from(schema.leads),
    db.select().from(schema.applications),
    db.select().from(schema.outreach),
    db.select().from(schema.digestLogs).orderBy(desc(schema.digestLogs.runAt)).limit(5),
  ]);
  return { jobs, leads, apps, pitches, digests };
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded border border-neutral-800 p-4">
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-xs text-neutral-400">{label}</div>
    </div>
  );
}

export default async function OverviewPage() {
  let data;
  let dbError: string | null = null;
  try {
    data = await loadStats();
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  if (dbError) {
    return (
      <div className="rounded border border-red-900 bg-red-950/40 p-4 text-sm text-red-200">
        Couldn&apos;t reach the database: {dbError}
        <br />
        Set DATABASE_URL in your Vercel project&apos;s environment variables, then redeploy.
      </div>
    );
  }

  const { jobs, leads, apps, pitches, digests } = data!;
  const readyApps = apps.filter((a) => a.status === "ready_for_review").length;
  const readyPitches = pitches.filter((p) => p.status === "ready_for_review").length;

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Jobs tracked" value={jobs.length} />
        <Stat label="Leads tracked" value={leads.length} />
        <Stat label="Apps ready for your review" value={readyApps} />
        <Stat label="Pitches ready for your review" value={readyPitches} />
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-neutral-300">Recent daily runs</h2>
        <div className="overflow-x-auto rounded border border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-900 text-neutral-400">
              <tr>
                <th className="p-2">Run at</th>
                <th className="p-2">New jobs</th>
                <th className="p-2">New leads</th>
                <th className="p-2">Apps auto-sent</th>
                <th className="p-2">Apps queued</th>
                <th className="p-2">Outreach auto-sent</th>
                <th className="p-2">Outreach queued</th>
                <th className="p-2">Errors</th>
              </tr>
            </thead>
            <tbody>
              {digests.map((d) => (
                <tr key={d.id} className="border-t border-neutral-800">
                  <td className="p-2">{d.runAt ? new Date(d.runAt).toLocaleString() : "-"}</td>
                  <td className="p-2">{d.newJobs}</td>
                  <td className="p-2">{d.newLeads}</td>
                  <td className="p-2">{d.applicationsAutoSent}</td>
                  <td className="p-2">{d.applicationsQueued}</td>
                  <td className="p-2">{d.outreachAutoSent}</td>
                  <td className="p-2">{d.outreachQueued}</td>
                  <td className="p-2 text-red-400">{(d.errors as string[] | null)?.length || 0}</td>
                </tr>
              ))}
              {digests.length === 0 && (
                <tr>
                  <td className="p-4 text-neutral-500" colSpan={8}>
                    No runs yet - the daily cron fires automatically, or trigger one manually via
                    GET /api/cron/daily?secret=YOUR_CRON_SECRET
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
