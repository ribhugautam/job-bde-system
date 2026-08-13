import { SKILLS, TARGET_ROLES, CONTRACT_KEYWORDS } from "./resumeData";
import { RawJob, RawLead } from "./sources/types";

function haystack(...parts: (string | undefined | string[])[]): string {
  return parts
    .flat()
    .filter(Boolean)
    .join(" \n ")
    .toLowerCase();
}

/**
 * Scores a job 0-100 against Ribhu's resume skills + target roles.
 * Returns the score plus human-readable reasons (shown in the dashboard so
 * it's obvious *why* something ranked where it did, not a black box).
 */
export function scoreJob(job: RawJob): { score: number; reasons: string[] } {
  const text = haystack(job.title, job.company, job.description, job.tags);
  const reasons: string[] = [];
  let raw = 0;
  let maxPossible = 0;

  for (const skill of SKILLS) {
    maxPossible += skill.weight;
    const names = [skill.name, ...(skill.aliases || [])];
    if (names.some((n) => text.includes(n))) {
      raw += skill.weight;
      reasons.push(`matches skill: ${skill.name}`);
    }
  }

  // Title/role bonus - up to 20 extra points if the title matches a role
  // Ribhu is actually targeting (prevents e.g. "React Native QA Tester"
  // from outscoring "Senior Next.js Engineer" purely on tag overlap).
  const title = (job.title || "").toLowerCase();
  const roleMatch = TARGET_ROLES.some((r) => title.includes(r));
  if (roleMatch) {
    raw += 8;
    reasons.push("title matches a targeted role");
  }

  // Remote bonus/penalty - remote is the stated preference, not a hard filter.
  if (job.remote) {
    raw += 4;
    reasons.push("remote");
  } else {
    reasons.push("NOT remote - lower priority");
  }

  // Seniority guard: penalize roles that read as far too junior or as
  // requiring 8+ years, since Ribhu's experience is ~2 years but at a
  // senior scope (led 15 engineers, architected multi-agent systems).
  if (/\b(intern|internship)\b/.test(title)) {
    raw -= 15;
    reasons.push("looks like an internship - deprioritized");
  }
  if (/\b(10\+|8\+|12\+)\s*years?\b/.test(text)) {
    raw -= 10;
    reasons.push("requires 8-12+ years experience - likely mismatch");
  }

  // Sources that give us no description (LinkedIn alert emails) can only match
  // skills present in the title, so their scores are structurally lower. We do
  // NOT inflate the number to compensate - the score stays an honest reflection
  // of the evidence - but we flag it so the dashboard and the lower sparse
  // threshold in pipeline.ts both make sense to a reader.
  if (job.sparse) {
    reasons.unshift(
      "scored on title only - this source provides no job description"
    );
  }

  const normalized = Math.max(
    0,
    Math.min(100, Math.round((raw / Math.max(maxPossible * 0.35, 1)) * 100))
  );

  return { score: normalized, reasons };
}

/**
 * Scores a freelance/contract lead 0-100. Leads are judged more loosely
 * since descriptions are often thin (RSS snippets).
 */
export function scoreLead(lead: RawLead): { score: number; reasons: string[] } {
  const text = haystack(lead.title, lead.clientOrCompany, lead.description);
  const reasons: string[] = [];
  let raw = 0;

  for (const kw of CONTRACT_KEYWORDS) {
    if (text.includes(kw)) {
      raw += 10;
      reasons.push(`matches: ${kw}`);
    }
  }

  if (lead.budgetText) {
    reasons.push(`budget listed: ${lead.budgetText}`);
    raw += 5;
  }

  const normalized = Math.max(0, Math.min(100, raw));
  return { score: normalized, reasons };
}
