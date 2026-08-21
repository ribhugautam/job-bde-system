// Structured version of Ribhu Gautam's resume, used for:
//  - scoring/matching jobs & leads (lib/domain/scoring/score.ts)
//  - populating cover letters & pitch emails (lib/domain/drafting/compose.ts)
//
// LINKEDIN: confirmed by Ribhu as /in/ribhugautam. The "ribhugutam" spelling
// seen earlier was a typo.
//
// GITHUB: still listed here as data, but deliberately NOT used in any outreach
// email — see the comment on SIGNATURE in lib/domain/drafting/compose.ts.
export const LINKS = {
  linkedin: "https://www.linkedin.com/in/ribhugautam",
  github: "https://github.com/ribhugautam",
  portfolio: "https://ribhugautam.vercel.app",
  ziro: "https://ziro-agent.com",
  email: "gautamribhu@gmail.com",
  phone: "+91 7807613493",
};

// Ribhu's continuous professional start date (Nature Technologies, SWE).
// Derived rather than written as prose, because the prose figure in CANDIDATE
// .summary below is the one number this system asserts that the CV does not,
// and a hardcoded "nearly 3 years" rots silently as time passes.
export const CAREER_START = new Date("2023-12-01T00:00:00Z");

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/** Years of professional experience as of `now`. */
export function yearsOfExperience(now: Date = new Date()): number {
  return Math.max(0, (now.getTime() - CAREER_START.getTime()) / MS_PER_YEAR);
}

export const CANDIDATE = {
  name: "Ribhu Gautam",
  title: "Full-Stack Software Engineer (Agentic AI / Next.js)",
  summary:
    // ~2 yr 8 mo as of Aug 2026 (Dec 2023 start). The CV states no figure, so
    // this is the one number the system asserts that the PDF does not — keep it
    // accurate as time passes.
    "Full-stack software engineer with nearly 3 years shipping production Next.js/React/TypeScript/Node apps and Flutter mobile apps, " +
    "and hands-on experience architecting agentic AI systems: LLM orchestration, custom RAG pipelines with PII-safety layers, " +
    "multi-agent pipelines, and MCP integrations. Has led a 15-engineer team and run client-facing requirements/demo calls with " +
    "US-based clients.",
};

// TIMELINE (confirmed by Ribhu, Aug 2026):
//   Nature Technologies is the continuous full-time thread — SWE from Dec 2023
//   to Jun 2024, promoted to M2 in Jul 2024, still there.
//   Excellence Technology and Tipzy ran CONCURRENTLY alongside Nature (and
//   alongside each other in Mar 2024), so `engagement` distinguishes them.
//
// TODO(ribhu): Tipzy's engagement type is still unconfirmed — "concurrent" is a
//   placeholder for freelance / part-time / contract. Set it correctly before
//   this ever gets rendered anywhere public.
//
// Only EXPERIENCE[0] is used in outreach (lib/domain/drafting/compose.ts). The
// entries below it are reference data for now — but if you ever widen
// compose.ts to quote more than the current role, the concurrency has to be
// visible or it reads as three simultaneous full-time jobs.
export const EXPERIENCE = [
  {
    role: "Software Engineer - M2",
    company: "Nature Technologies Pvt Ltd",
    engagement: "full-time",
    dates: "Jul 2024 - Present",
    highlights: [
      "Leading a 15-member engineering team; improved delivery efficiency by 30% through workflow and PR review changes.",
      "Vista: AI-driven lead-gen, cold calling, and marketing automation platform for US dealerships with real-time analytics.",
      "TRC: AI-powered financial advisory platform on LLMs/OpenRouter with a custom in-house RAG pipeline and a built-in PII-safety layer; integrated Addepar, Affinity, Dropbox, PitchBook as live data sources; multi-agent workflow automation via Paperclip, Hermes, OpenClaw.",
      "Gummy Gardens: fully automated marketing platform generating full campaigns (idea -> video -> publishing) with zero manual intervention.",
      "Dark Factory: architected an internal 5-agent autonomous development pipeline (plan -> code -> peer review -> security scan -> automated tests) with human review gates before merge; scaled it into a company-wide cloud-hosted platform.",
      "Ships both the Next.js web app and Flutter mobile app for the same product line at 95% feature parity.",
      "Set up monorepo architecture, cutting deployment/setup time by 40%.",
      "Mentors junior engineers and runs requirements/demo calls with US-based clients (90%+ satisfaction).",
    ],
  },
  {
    role: "Software Engineer",
    company: "Nature Technologies Pvt Ltd",
    engagement: "full-time",
    dates: "Dec 2023 - Jun 2024",
    highlights: [
      "Built/maintained React ERP apps (MBND, RK Auto) live in production, +20% performance via architectural optimization.",
      "Migrated ChatLead from React 16 to 18, cutting build/start times by 35%.",
      "Shipped a chat window builder that grew adoption 40%.",
      "Modernized legacy deployments via IIS + Azure CI/CD, reducing downtime 25%.",
      "Introduced Vitest testing (+50% coverage, -35% production bugs).",
    ],
  },
  {
    role: "Full-Stack Developer",
    company: "Tipzy (Script Studio Technology Pvt Ltd)",
    engagement: "concurrent", // TODO(ribhu): freelance / part-time / contract?
    dates: "Mar 2024 - Oct 2024",
    highlights: [
      "Built 3 interconnected apps/microservices, +35% platform efficiency.",
      "Architected a modular reusable component structure, -25% new feature dev time.",
      "Optimized data flow with Redux Toolkit + TanStack Query, +30% API handling.",
      "+30% backend throughput, 99.9% uptime.",
    ],
  },
  {
    role: "Full-Stack Trainee",
    company: "Excellence Technology",
    engagement: "traineeship, concurrent with Nature",
    dates: "Jan 2024 - Mar 2024",
    highlights: [
      "Built responsive React/Tailwind/Appwrite apps, -15% load time, +25% mobile usability.",
    ],
  },
];

export const PROJECTS = [
  {
    name: "Ziro - Terminal Agent Runtime",
    url: LINKS.ziro,
    dates: "2026 - Present",
    highlights: [
      "Local-first terminal agent runtime in Python; conversations/memory/files never leave the user's disk.",
      "Layered YAML config model (project > user > package) for persona, model, provider, tools, permissions, guardrails, compaction.",
      "Default-deny permission layer for shell/filesystem access; headless runs fail closed.",
      "On-demand tool registry the model searches per task, keeping a large tool surface at near-zero context cost.",
      "MCP client over stdio/SSE/streamable HTTP; storage on SQLite+FAISS by default, swaps to Postgres+pgvector via one env var.",
    ],
  },
];

export const EDUCATION = {
  degree: "B.Tech, Computer Science Engineering",
  school: "Chandigarh Group of Colleges",
  dates: "2020 - 2024",
  gpa: "7.83/10",
};

// ---------------------------------------------------------------------------
// Compatibility re-exports.
//
// The skill list, target roles, veto phrases and contract keywords USED to be
// defined in this file, which is what made "rank jobs against my resume"
// impossible for anyone but Ribhu — one person's resume was compiled into the
// program. They now live in ./taxonomy.ts as a shared dictionary, and a user's
// own subset lives in ./profile.ts.
//
// These aliases exist because lib/domain/drafting/compose.ts still writes in
// Ribhu's voice — his name, links, experience and side project are woven
// through every template — so it genuinely still wants the ORIGINAL profile,
// not a viewer's. Per-user drafting is a separate change; until then, pointing
// the old names at the default profile keeps one source of truth instead of
// two lists drifting apart.
// ---------------------------------------------------------------------------
export {
  DEFAULT_PROFILE_SKILLS as SKILLS,
  DEFAULT_TARGET_ROLES as TARGET_ROLES,
  ROLE_VETO_PHRASES,
  CONTRACT_KEYWORDS,
} from "./taxonomy";
