import { CANDIDATE, EXPERIENCE, PROJECTS, LINKS, SKILLS } from "./resumeData";
import { RawJob, RawLead } from "./sources/types";

// NOTE: GitHub is deliberately NOT in the signature. github.com/ribhugautam's
// pinned repos are early student projects (analogclock, a CSS e-commerce page,
// a "learn backend" YouTube clone) which actively contradict the senior
// agentic-AI positioning of these emails. Ziro + the portfolio carry that
// weight instead. To put GitHub back, repin the profile first, then add
// `GitHub: ${LINKS.github}` below and to the prompt in generateCoverLetter.
const SIGNATURE = `\n\n${CANDIDATE.name}\n${LINKS.email} | ${LINKS.phone}\nLinkedIn: ${LINKS.linkedin}\nPortfolio: ${LINKS.portfolio}\nZiro (agentic AI side project): ${LINKS.ziro}`;

function topEmphasizedSkills(text: string, limit = 5): string[] {
  const lower = text.toLowerCase();
  return SKILLS.filter((s) =>
    [s.name, ...(s.aliases || [])].some((n) => lower.includes(n))
  )
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
// Optional Claude-generated drafts. Falls back to the template above if
// ANTHROPIC_API_KEY isn't set, or if the call fails for any reason - a
// draft always exists, it just may be less polished.
// ---------------------------------------------------------------------------
async function claudeDraft(prompt: string): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
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
  job: RawJob
): Promise<{ text: string; emphasizedSkills: string[]; generatedBy: "template" | "claude" }> {
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

  const aiText = await claudeDraft(prompt);
  return aiText
    ? { text: aiText + SIGNATURE, emphasizedSkills: emphasized, generatedBy: "claude" }
    : { text: template, emphasizedSkills: emphasized, generatedBy: "template" };
}

export async function generatePitch(
  lead: RawLead
): Promise<{ text: string; emphasizedSkills: string[]; generatedBy: "template" | "claude" }> {
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

  const aiText = await claudeDraft(prompt);
  return aiText
    ? { text: aiText + SIGNATURE, emphasizedSkills: emphasized, generatedBy: "claude" }
    : { text: template, emphasizedSkills: emphasized, generatedBy: "template" };
}
