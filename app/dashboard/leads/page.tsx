import { getDb, schema } from "@/lib/db/client";
import { desc } from "drizzle-orm";
import StatusBadge from "@/components/StatusBadge";
import { StatusSelect } from "@/components/ActionButtons";

export const dynamic = "force-dynamic";

const LEAD_STATUSES = [
  "found", "matched", "pitched", "sent", "responded", "won", "lost", "ignored",
];

export default async function LeadsPage() {
  const db = getDb();
  const leads = await db.select().from(schema.leads).orderBy(desc(schema.leads.score)).limit(200);

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-neutral-300">
        {leads.length} freelance/contract leads, ranked by fit score
      </h2>
      <div className="space-y-2">
        {leads.map((lead) => (
          <div key={lead.id} className="rounded border border-neutral-800 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <a
                  href={lead.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-white hover:underline"
                >
                  {lead.title}
                </a>
                <div className="text-xs text-neutral-400">
                  {lead.clientOrCompany || "unknown client"} · {lead.source}
                  {lead.budgetText ? ` · ${lead.budgetText}` : ""}
                  {lead.contactEmail ? " · has contact email" : " · no direct contact - reply via platform"}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-neutral-400">score {lead.score}</span>
                <StatusBadge status={lead.status} />
                <StatusSelect entity="lead" id={lead.id} status={lead.status} options={LEAD_STATUSES} />
              </div>
            </div>
          </div>
        ))}
        {leads.length === 0 && (
          <p className="text-sm text-neutral-500">
            No leads yet. Note: Upwork RSS is disabled by default (ENABLE_UPWORK_RSS) until you
            verify the feed still works - see README.
          </p>
        )}
      </div>
    </div>
  );
}
