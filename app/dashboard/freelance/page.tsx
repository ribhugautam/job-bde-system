import { getDb, schema } from "@/lib/infra/db/client";
import { desc, inArray } from "drizzle-orm";
import { LEAD_STATUSES } from "@/lib/pipeline/state";
import StatusBadge from "@/components/StatusBadge";
import { StatusSelect, SendOutreachButton } from "@/components/ActionButtons";
import DbErrorNotice from "@/components/DbErrorNotice";

export const dynamic = "force-dynamic";

/**
 * Leads (find a freelance gig) and Pitches (the outreach drafted for it) are
 * two halves of one workflow, so they share a page rather than living behind
 * separate nav entries.
 */
export default async function FreelancePage() {
  let leads;
  let pitches;
  let leadById;
  try {
    const db = getDb();

    leads = await db
      .select()
      .from(schema.leads)
      .orderBy(desc(schema.leads.score))
      .limit(200);

    pitches = await db
      .select()
      .from(schema.outreach)
      .orderBy(desc(schema.outreach.createdAt))
      .limit(200);

    // Only the leads these pitches reference — not the whole leads table.
    const leadIds = [...new Set(pitches.map((p) => p.leadId))];
    const pitchLeads = leadIds.length
      ? await db.select().from(schema.leads).where(inArray(schema.leads.id, leadIds))
      : [];
    leadById = new Map(pitchLeads.map((l) => [l.id, l]));
  } catch (err) {
    return <DbErrorNotice error={err} />;
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-(--text-muted)">
          {leads.length} freelance/contract leads, ranked by fit score
        </h2>
        <div className="overflow-hidden rounded border border-(--border) divide-y divide-(--border)">
          {leads.map((lead) => (
            <div
              key={lead.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 hover:bg-(--surface-hover)"
            >
              <span className="tnum w-8 shrink-0 text-right text-xs font-semibold text-(--text)">
                {lead.score}
              </span>
              <div className="min-w-0 flex-1">
                <a
                  href={lead.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block truncate text-[13px] text-(--text) hover:underline"
                >
                  <span className="font-semibold">{lead.title}</span>
                  <span className="text-(--text-muted)">
                    {" "}
                    · {lead.clientOrCompany || "unknown client"}
                  </span>
                </a>
                <div className="truncate text-[11px] text-(--text-faint)">
                  {lead.source}
                  {lead.budgetText ? ` · ${lead.budgetText}` : ""}
                  {lead.contactEmail
                    ? " · has contact email"
                    : " · no direct contact - reply via platform"}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <StatusBadge status={lead.status} />
                <StatusSelect
                  entity="lead"
                  id={lead.id}
                  status={lead.status}
                  options={[...LEAD_STATUSES]}
                />
              </div>
            </div>
          ))}
          {leads.length === 0 && (
            <p className="px-3 py-6 text-sm text-(--text-dim)">
              No leads yet. Upwork RSS is disabled by default (ENABLE_UPWORK_RSS) —
              the feed returns 410 Gone and Upwork sends no job alert emails at all.
              See docs/superpowers/specs/2026-08-14-job-facts-followups.md for how
              to unblock it.
            </p>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-(--text-muted)">
          {pitches.length} outreach pitches
        </h2>
        <div className="overflow-hidden rounded border border-(--border) divide-y divide-(--border)">
          {pitches.map((pitch) => {
            const lead = leadById.get(pitch.leadId);
            return (
              <div key={pitch.id} className="px-3 py-2 hover:bg-(--surface-hover)">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-(--text)">
                      <span className="font-semibold">
                        {lead?.title || `Lead #${pitch.leadId}`}
                      </span>
                      {lead?.clientOrCompany && (
                        <span className="text-(--text-muted)"> — {lead.clientOrCompany}</span>
                      )}
                    </div>
                    <div className="truncate text-[11px] text-(--text-faint)">
                      {pitch.sendMode === "auto_email"
                        ? "auto-email eligible"
                        : "manual - reply via platform"}{" "}
                      · generated by {pitch.generatedBy}
                      {pitch.sentTo ? ` · sent to ${pitch.sentTo}` : ""}
                    </div>
                    {lead && (
                      <a
                        href={lead.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[11px] text-(--text-muted) hover:text-(--text) hover:underline"
                      >
                        open listing →
                      </a>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <StatusBadge status={pitch.status} />
                    {pitch.status === "ready_for_review" && (
                      <SendOutreachButton outreachId={pitch.id} />
                    )}
                  </div>
                </div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-[11px] text-(--text-dim)">
                    view pitch
                  </summary>
                  <pre className="mt-2 whitespace-pre-wrap rounded bg-(--surface) p-3 text-xs text-(--text-muted)">
                    {pitch.pitch}
                  </pre>
                </details>
                {pitch.error && (
                  <p className="mt-1 text-[11px] text-(--danger-fg)">error: {pitch.error}</p>
                )}
              </div>
            );
          })}
          {pitches.length === 0 && (
            <p className="px-3 py-6 text-sm text-(--text-dim)">No outreach pitches drafted yet.</p>
          )}
        </div>
      </section>
    </div>
  );
}
