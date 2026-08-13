import { sendDigest } from "@/lib/infra/mail/send";
import { LINKS } from "@/lib/domain/scoring/resume-profile";
import type { StageContext } from "../context";

// ---------------------------------------------------------------------------
// Digest: the run's only outward report.
//
// This matters more than it looks. Everything else here runs unattended, so the
// digest is the sole channel through which a silent failure becomes visible. It
// is therefore written even when the run went badly, sent last so nothing can
// pre-empt it, and it leads with problems rather than burying them under
// counters that look healthy.
// ---------------------------------------------------------------------------

export function buildSummary(
  ctx: StageContext,
  opts: { budgetExhausted: boolean }
): string {
  const c = ctx.counters;
  const lines: string[] = [];

  if (ctx.env.DRY_RUN) {
    lines.push(
      "*** DRY RUN - no email was sent. Everything below was drafted only. ***",
      ""
    );
  }

  lines.push(
    `New jobs: ${c.newJobs} | New leads: ${c.newLeads} | Duplicates merged: ${c.duplicatesMerged}`,
    `LinkedIn descriptions recovered: ${c.jobsEnriched}`,
    `Applications auto-sent: ${c.applicationsAutoSent} | queued for one-click: ${c.applicationsQueued}`,
    `Outreach auto-sent: ${c.outreachAutoSent} | queued for review: ${c.outreachQueued}`,
    `Replies detected: ${c.repliesDetected} | Follow-ups sent: ${c.followUpsSent}`
  );

  if (opts.budgetExhausted) {
    lines.push(
      "",
      "NOTE: the worker ran out of time with work still queued. Nothing was " +
        "lost - it resumes on the next run - but if this repeats, the cron is " +
        "firing too rarely for the volume. On Vercel Pro, change the schedule " +
        "in vercel.json to */15 * * * *."
    );
  }

  // Errors first and clearly labelled as things that BROKE. Notices are listed
  // separately below: mixing them made a run with two dead sources and three
  // switched-off ones read as "5 errors", which is how a real failure hides.
  if (ctx.errors.length) {
    lines.push("", `PROBLEMS - these need fixing (${ctx.errors.length}):`);
    // Capped: a source that breaks can generate one line per listing, and a
    // digest that is 400 lines of the same message is one nobody reads.
    const shown = ctx.errors.slice(0, 40);
    lines.push(...shown.map((e) => `- ${e}`));
    if (ctx.errors.length > shown.length) {
      lines.push(
        `- ...and ${ctx.errors.length - shown.length} more (see the run log in the dashboard)`
      );
    }
  }

  if (ctx.notices.length) {
    lines.push("", `For information (${ctx.notices.length}):`);
    const shown = ctx.notices.slice(0, 20);
    lines.push(...shown.map((n) => `- ${n}`));
    if (ctx.notices.length > shown.length) {
      lines.push(`- ...and ${ctx.notices.length - shown.length} more`);
    }
  }

  if (!ctx.errors.length) {
    lines.push("", "No errors.");
  }

  return lines.join("\n");
}

export async function sendDigestEmail(
  ctx: StageContext,
  summary: string
): Promise<void> {
  // DRY_RUN suppresses the digest too. That is deliberate: the flag's promise is
  // that nothing at all leaves your mailbox, and a "nothing was sent" email is
  // still an email.
  if (ctx.env.DRY_RUN) return;

  const appUrl = ctx.env.NEXT_PUBLIC_APP_URL;
  const c = ctx.counters;

  const body = [
    summary,
    "",
    appUrl
      ? `Apply queue (${c.applicationsQueued} waiting on one keystroke): ${appUrl}/dashboard/queue`
      : "Set NEXT_PUBLIC_APP_URL to get a direct link to the apply queue here.",
    "",
    `Links on file: LinkedIn ${LINKS.linkedin}, Portfolio ${LINKS.portfolio}, Ziro ${LINKS.ziro}`,
  ].join("\n");

  // Only real errors reach the subject. A subject that cries wolf about
  // configuration notices trains you to stop reading it.
  const subject =
    `Job pipeline - ${c.newJobs} jobs, ${c.newLeads} leads` +
    (c.repliesDetected ? `, ${c.repliesDetected} replies` : "") +
    (ctx.errors.length
      ? ` (${ctx.errors.length} problem${ctx.errors.length === 1 ? "" : "s"})`
      : "");

  const result = await sendDigest(subject, body);
  if (!result.ok) {
    ctx.errors.push(`digest email: ${result.error}`);
  }
}
