// Structured version of Ribhu Gautam's resume, used for:
//  - scoring/matching jobs & leads (lib/matcher.ts)
//  - populating cover letters & pitch emails (lib/drafts.ts)
//
// LINKEDIN: confirmed by Ribhu as /in/ribhugautam. The "ribhugutam" spelling
// seen earlier was a typo.
//
// GITHUB: still listed here as data, but deliberately NOT used in any outreach
// email — see the comment on SIGNATURE in lib/drafts.ts.
export const LINKS = {
  linkedin: "https://www.linkedin.com/in/ribhugautam",
  github: "https://github.com/ribhugautam",
  portfolio: "https://ribhugautam.vercel.app",
  ziro: "https://ziro-agent.com",
  email: "gautamribhu@gmail.com",
  phone: "+91 7807613493",
};

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

// Weighted skills used by the matcher. Weight roughly reflects resume-listed
// proficiency (Strong/Intermediate/Beginner) plus how central it is to
// Ribhu's actual shipped work (e.g. "agentic ai" shows up in every current
// project, so it's weighted like a Strong skill even though it's not a
// single line item on the resume).
export const SKILLS: { name: string; weight: number; aliases?: string[] }[] = [
  // Strong
  { name: "react", weight: 3, aliases: ["react.js", "reactjs"] },
  { name: "next.js", weight: 3, aliases: ["nextjs", "next js"] },
  { name: "typescript", weight: 3, aliases: ["ts"] },
  { name: "javascript", weight: 3, aliases: ["js"] },
  { name: "node.js", weight: 3, aliases: ["node", "nodejs"] },
  { name: "flutter", weight: 3 },
  { name: "dart", weight: 2 },
  { name: "tailwind", weight: 2, aliases: ["tailwind css", "tailwindcss"] },
  { name: "redux toolkit", weight: 2, aliases: ["redux"] },
  { name: "tanstack query", weight: 2, aliases: ["react query"] },
  { name: "mongodb", weight: 2 },
  { name: "rest api", weight: 2, aliases: ["restful", "rest apis"] },
  { name: "aws amplify", weight: 2, aliases: ["amplify"] },
  { name: "appwrite", weight: 1 },
  { name: "azure devops", weight: 2, aliases: ["azure ci/cd", "azure", "ci/cd"] },
  { name: "github actions", weight: 2, aliases: ["ci/cd pipeline"] },
  { name: "monorepo", weight: 2, aliases: ["turborepo", "nx monorepo"] },
  { name: "microservices", weight: 2, aliases: ["microservice"] },
  { name: "api integration", weight: 2, aliases: ["third-party api", "third party api"] },
  { name: "agile", weight: 1, aliases: ["scrum"] },
  { name: "git", weight: 2 },
  { name: "architecture", weight: 2, aliases: ["system design", "architecture design"] },

  // Agentic AI cluster — weighted heavily, this is Ribhu's differentiator
  { name: "agentic ai", weight: 4, aliases: ["ai agent", "ai agents", "autonomous agent"] },
  { name: "llm", weight: 4, aliases: ["large language model", "llm orchestration"] },
  { name: "rag", weight: 4, aliases: ["retrieval augmented generation", "rag pipeline"] },
  { name: "multi-agent", weight: 4, aliases: ["multi agent", "multiagent"] },
  { name: "mcp", weight: 4, aliases: ["model context protocol"] },
  { name: "prompt engineering", weight: 3 },
  { name: "openrouter", weight: 2 },
  { name: "claude", weight: 2, aliases: ["claude ai", "anthropic"] },
  { name: "copilot", weight: 1, aliases: ["github copilot"] },
  { name: "perplexity", weight: 1 },
  { name: "openclaw", weight: 1 },

  // Intermediate
  { name: "express.js", weight: 2, aliases: ["express"] },
  { name: "sql", weight: 2 },
  { name: "python", weight: 2 },
  { name: "docker", weight: 2 },
  { name: "aws s3", weight: 1 },
  { name: "aws lambda", weight: 1, aliases: ["serverless"] },
  { name: "iis", weight: 1 },
  { name: "vitest", weight: 2, aliases: ["unit testing", "integration testing"] },
  { name: "vector search", weight: 3, aliases: ["faiss", "pgvector", "vector database"] },
  { name: "postgresql", weight: 2, aliases: ["postgres"] },
  { name: "sqlite", weight: 1 },

  // Beginner
  { name: "react native", weight: 1 },
  { name: "machine learning", weight: 1, aliases: ["ml"] },
];

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
// Only EXPERIENCE[0] is used in outreach (lib/drafts.ts). The entries below it
// are reference data for now — but if you ever widen drafts.ts to quote more
// than the current role, the concurrency has to be visible or it reads as
// three simultaneous full-time jobs.
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

// Roles Ribhu is targeting - drives which job titles score highest.
export const TARGET_ROLES = [
  "full stack developer",
  "full stack engineer",
  "software engineer",
  "frontend engineer",
  "front end developer",
  "react developer",
  "next.js developer",
  "node.js developer",
  "flutter developer",
  "ai engineer",
  "agentic ai engineer",
  "llm engineer",
  "applied ai engineer",
  "founding engineer",
];

// Contract/freelance keywords used when scoring `leads`.
export const CONTRACT_KEYWORDS = [
  "react", "next.js", "nextjs", "typescript", "node", "flutter",
  "ai agent", "llm", "rag", "chatbot", "automation", "mvp", "full stack",
];
