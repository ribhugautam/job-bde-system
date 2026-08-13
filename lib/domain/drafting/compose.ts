// Draft generation for outbound email: cover letters (jobs), pitches (leads),
// and follow-up nudges for both.
//
// This module is pure domain code: it reads nothing from process.env and talks
// to no database. The one external call it can make (Anthropic) is opt-in and
// only happens when the caller hands it an `apiKey` - see DraftOptions. The
// pipeline stage that owns env access is responsible for passing it in.
//
// Related: scoring lives in lib/domain/scoring/score.ts, and the resume data
// used below in lib/domain/scoring/resume-profile.ts.

import { CANDIDATE, EXPERIENCE, PROJECTS, LINKS, SKILLS } from "../scoring/resume-profile";
import { RawJob, RawLead } from "@/lib/domain/types";

// NOTE: GitHub is deliberately NOT in the signature. github.com/ribhugautam's
// pinned repos are early student projects (analogclock, a CSS e-commerce page,
// a "learn backend" YouTube clone) which actively contradict the senior
// agentic-AI positioning of these emails. Ziro + the portfolio carry that
// weight instead. To put GitHub back, repin the profile first, then add
// `GitHub: ${LINKS.github}` below, to the prompt in generateCoverLetter, and to
// followUpSignature.
const SIGNATURE = `\n\n${CANDIDATE.name}\n${LINKS.email} | ${LINKS.phone}\nLinkedIn: ${LINKS.linkedin}\nPortfolio: ${LINKS.portfolio}\nZiro (agentic AI side project): ${LINKS.ziro}`;

export type Draft = {
  text: string;
  emphasizedSkills: string[];
  generatedBy: "template" | "claude";
};

/**
 * Optional per-call configuration.
 *
 * `apiKey` is passed in by the caller rather than read from process.env so that
 * this module stays free of environment access. Omit it (the default) and
 * drafting is fully deterministic and offline: no network call is attempted and
 * `generatedBy` is always "template".
 */
export type DraftOptions = {
  apiKey?: string;
};

// Skill terms are matched on word boundaries rather than as raw substrings.
// The short aliases make plain `includes()` actively wrong: "ts" (TypeScript)
// matches "baskets", "ml" matches "html", "js" matches any sentence containing
// "js"-suffixed words. That is how a basket-weaving post ends up with
// "typescript" emphasized in its cover letter. Every name/alias starts and ends
// with a word character, so wrapping the alternation in \b is safe.
const SKILL_MATCHERS = SKILLS.map((skill) => ({
  skill,
  pattern: new RegExp(
    `\\b(?:${[skill.name, ...(skill.aliases || [])]
      .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|")})\\b`,
    "i"
  ),
}));

function topEmphasizedSkills(text: string, limit = 5): string[] {
  return SKILL_MATCHERS.filter(({ pattern }) => pattern.test(text))
    .map(({ skill }) => skill)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit)
    .map((s) => s.name);
}

function templateCoverLetter(job: RawJob, emphasized: string[]): string {
  const recentRole = EXPERIENCE[0];
  const zirRelevant = emphasized.some((s) =>
    ["agentic ai", "llm", "rag", "multi-agent", "mcp"].includes(s)
  );

  return [
    `Hi,`,
    ``,
    `I'm ${CANDIDATE.name}, a full-stack engineer currently ${recentRole.role} at ${recentRole.company}, and I'd like to apply for the ${job.title} role${job.company ? ` at ${job.company}` : ""}.`,
    ``,
    `A few things that line up directly with what you're looking for: ${emphasized.length ? emphasized.join(", ") : "React/Next.js/TypeScript/Node full-stack development"}. In my current role I lead a 15-engineer team and have shipped production agentic AI systems - LLM orchestration, custom RAG pipelines with a PII-safety layer, and multi-agent pipelines that run planning, coding, review, security scanning, and testing as separate agents with human review gates before merge.`,
    zirRelevant
      ? `I also maintain Ziro (${LINKS.ziro}), a local-first terminal agent runtime I built from scratch, covering MCP client integration, permissioned tool execution, and long-term memory with automatic compaction - directly relevant to this kind of work.`
      : `I also ship both the Next.js web app and Flutter mobile app for the same product line at 95% feature parity, and have set up monorepo architectures that cut deployment/setup time by 40%.`,
    ``,
    `Happy to jump on a call to go through specifics whenever works for you.`,
    ``,
    `Thanks,`,
  ].join("\n") + SIGNATURE;
}

function templatePitch(lead: RawLead, emphasized: string[]): string {
  return [
    `Hi,`,
    ``,
    `Saw your post for "${lead.title}"${lead.clientOrCompany ? ` (${lead.clientOrCompany})` : ""} - this is squarely in my lane.`,
    ``,
    `I'm ${CANDIDATE.name}, a full-stack engineer (Next.js/React/TypeScript/Node/Flutter) who also builds production agentic AI systems - LLM orchestration, RAG pipelines, multi-agent workflows, MCP integrations. Currently leading a 15-engineer team at Nature Technologies and shipping exactly this kind of work for US-based clients.`,
    emphasized.length
      ? `Specifically relevant here: ${emphasized.join(", ")}.`
      : ``,
    `Portfolio: ${LINKS.portfolio} | A side project that shows the agentic-AI work directly: ${LINKS.ziro}`,
    ``,
    `If it's a fit, I'd like to hop on a quick call to talk through scope and timeline.`,
    ``,
    `Best,`,
  ]
    .filter(Boolean)
    .join("\n") + SIGNATURE;
}

// ---------------------------------------------------------------------------
// Optional Claude-generated drafts. Falls back to the template above when the
// caller passes no apiKey, or if the call fails for any reason - a draft always
// exists, it just may be less polished.
// ---------------------------------------------------------------------------
async function claudeDraft(prompt: string, apiKey?: string): Promise<string | null> {
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-3-5-haiku-20241022",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.content?.[0]?.text;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  } catch {
    return null;
  }
}

export async function generateCoverLetter(
  job: RawJob,
  options: DraftOptions = {}
): Promise<Draft> {
  const emphasized = topEmphasizedSkills(
    `${job.title} ${job.description || ""} ${(job.tags || []).join(" ")}`
  );
  const template = templateCoverLetter(job, emphasized);

  const prompt = `Write a concise (150-200 word) cold application email for this job, in a direct, non-cringe tone, no buzzwords, from this candidate. End with a one-line call to action for a call. Do not fabricate any experience beyond what's given.

CANDIDATE RESUME SUMMARY:
${CANDIDATE.summary}
Recent role: ${EXPERIENCE[0].role} at ${EXPERIENCE[0].company} - ${EXPERIENCE[0].highlights.slice(0, 4).join(" ")}
Side project: ${PROJECTS[0].name} - ${PROJECTS[0].highlights.slice(0, 3).join(" ")}
Links: LinkedIn ${LINKS.linkedin}, Portfolio ${LINKS.portfolio}, Ziro ${LINKS.ziro}

JOB:
Title: ${job.title}
Company: ${job.company}
Description: ${(job.description || "").slice(0, 1500)}

Output only the email body, no subject line, sign off with just "Thanks," (the signature block is appended separately).`;

  const aiText = await claudeDraft(prompt, options.apiKey);
  return aiText
    ? { text: aiText + SIGNATURE, emphasizedSkills: emphasized, generatedBy: "claude" }
    : { text: template, emphasizedSkills: emphasized, generatedBy: "template" };
}

export async function generatePitch(
  lead: RawLead,
  options: DraftOptions = {}
): Promise<Draft> {
  const emphasized = topEmphasizedSkills(
    `${lead.title} ${lead.description || ""}`
  );
  const template = templatePitch(lead, emphasized);

  const prompt = `Write a concise (120-160 word) cold outreach/pitch email responding to this freelance/contract job post, direct and non-cringe, no buzzwords, from this candidate. Do not fabricate experience. End asking for a quick call.

CANDIDATE RESUME SUMMARY:
${CANDIDATE.summary}
Links: Portfolio ${LINKS.portfolio}, Ziro (agentic AI project) ${LINKS.ziro}

LEAD POST:
Title: ${lead.title}
Client/Company: ${lead.clientOrCompany || "unknown"}
Description: ${(lead.description || "").slice(0, 1200)}

Output only the email body, sign off with just "Best," (signature appended separately).`;

  const aiText = await claudeDraft(prompt, options.apiKey);
  return aiText
    ? { text: aiText + SIGNATURE, emphasizedSkills: emphasized, generatedBy: "claude" }
    : { text: template, emphasizedSkills: emphasized, generatedBy: "template" };
}

// ---------------------------------------------------------------------------
// Follow-ups
//
// The sequence is deliberately tiny: one nudge (step 1, ~day 4) and one final
// message (step 2, ~day 10), then silence forever. Everything here is written
// to survive that constraint:
//
//  - 3 sentences, never a re-run of the original email. A follow-up that
//    restates the cover letter is worse than no follow-up at all.
//  - Step 2 has to read as genuinely final. It closes the loop and promises no
//    further contact, because there is none - no "I'll check back next week".
//  - Nothing is invented. The only facts available are the role, the company,
//    and that an earlier message was sent. No mutual connections, no prior
//    calls, no deadlines.
//  - Cold outreach never mentions or attaches a CV: an unsolicited email
//    carrying a PDF scores worse with spam filters, and freelance clients want
//    a portfolio link before a resume. Application follow-ups may reference it.
//
// Composition only - scheduling, "did they reply", and the hard stop after
// step 2 belong to the caller.
// ---------------------------------------------------------------------------

export type FollowUpKind = "application" | "outreach";

/** 1 = first nudge (~day 4), 2 = final message (~day 10). There is no step 3. */
export type FollowUpStep = 1 | 2;

export type FollowUpInput = {
  kind: FollowUpKind;
  step: FollowUpStep;
  roleTitle: string;
  company?: string;
  /** Subject of the message being followed up on, with or without a "Re:". */
  originalSubject: string;
  /** Days since that message went out; ignored if it isn't a positive number. */
  daysSince: number;
};

export type FollowUp = { subject: string; text: string };

/**
 * Same no-GitHub rule as SIGNATURE above - see that comment before adding one.
 * Shorter than SIGNATURE on purpose: a three-sentence email should not carry a
 * six-line footer. Outreach leads with the portfolio + Ziro (what a freelance
 * client asks for first); applications lead with LinkedIn + portfolio.
 */
function followUpSignature(kind: FollowUpKind): string {
  const links =
    kind === "application"
      ? [`LinkedIn: ${LINKS.linkedin}`, `Portfolio: ${LINKS.portfolio}`]
      : [`Portfolio: ${LINKS.portfolio}`, `Ziro (agentic AI side project): ${LINKS.ziro}`];
  return ["", "", CANDIDATE.name, `${LINKS.email} | ${LINKS.phone}`, ...links].join("\n");
}

/**
 * Builds the reply-style subject. Any existing "Re:" chain is collapsed to a
 * single prefix so threading works without producing "Re: Re: Re: ...".
 */
function threadSubject(originalSubject: string, fallback: string): string {
  const base = (originalSubject || "").trim();
  const stripped = base.replace(/^(?:\s*re\s*:\s*)+/i, "").trim();
  return `Re: ${stripped || fallback}`;
}

/** "yesterday" / "6 days ago", or null when daysSince isn't usable. */
function daysAgoPhrase(daysSince: number): string | null {
  if (typeof daysSince !== "number" || !Number.isFinite(daysSince)) return null;
  const n = Math.round(daysSince);
  if (n < 1) return null;
  return n === 1 ? "yesterday" : `${n} days ago`;
}

export function composeFollowUp(input: FollowUpInput): FollowUp {
  const roleTitle = (input.roleTitle || "").trim();
  const company = input.company?.trim() || undefined;
  const ago = daysAgoPhrase(input.daysSince);

  const subjectFallback =
    input.kind === "application"
      ? `Application - ${roleTitle}${company ? ` (${company})` : ""}`
      : `${roleTitle}${company ? ` (${company})` : ""}`;

  const lines =
    input.kind === "application"
      ? applicationFollowUpLines(input.step, roleTitle, company, ago)
      : outreachFollowUpLines(input.step, roleTitle, company, ago);

  return {
    subject: threadSubject(input.originalSubject, subjectFallback),
    text: lines.join("\n") + followUpSignature(input.kind),
  };
}

function applicationFollowUpLines(
  step: FollowUpStep,
  roleTitle: string,
  company: string | undefined,
  ago: string | null
): string[] {
  const role = `the ${roleTitle} role${company ? ` at ${company}` : ""}`;

  if (step === 1) {
    return [
      `Hi,`,
      ``,
      `I'm following up on my application for ${role}${ago ? `, sent ${ago}` : ""}.`,
      `I'm still very interested, and I'd be glad to answer any questions or resend my CV if that's easier.`,
      `Is there anything else you need from me at this point?`,
      ``,
      `Thanks,`,
    ];
  }

  return [
    `Hi,`,
    ``,
    `I applied for ${role}${ago ? ` ${ago}` : ""} and wanted to send one final note rather than keep checking in.`,
    `If it's still open and my CV is worth a second look, I'd be glad to talk; if not, no reply is needed.`,
    `Either way, thanks for your time and good luck with the search.`,
    ``,
    `Thanks,`,
  ];
}

function outreachFollowUpLines(
  step: FollowUpStep,
  roleTitle: string,
  company: string | undefined,
  ago: string | null
): string[] {
  const post = `your "${roleTitle}" post${company ? ` (${company})` : ""}`;

  if (step === 1) {
    return [
      `Hi,`,
      ``,
      ago
        ? `I'm following up on the note I sent ${ago} about ${post}.`
        : `I'm following up on my earlier note about ${post}.`,
      // Link mid-sentence, never trailing: a URL followed by a full stop gets
      // swallowed into the href by some mail clients.
      `Still glad to take it on if it's open - my portfolio is at ${LINKS.portfolio} if it's useful.`,
      `If it helps, I can put together a short scope-and-timeline outline before any call.`,
      ``,
      `Best,`,
    ];
  }

  return [
    `Hi,`,
    ``,
    `I'll close the loop on ${post} here - this is my last message about it.`,
    `If it's still open, or something like it comes up later, my portfolio and contact details are below.`,
    `Best of luck with the project either way.`,
    ``,
    `Best,`,
  ];
}
