// ---------------------------------------------------------------------------
// The shared vocabulary the matcher and the resume extractor both speak.
//
// This used to be one person's resume. `SKILLS` in resume-profile.ts was both
// "the words this system knows about" AND "the skills Ribhu has" — fine while
// there was one user, and unworkable the moment a colleague has a different
// stack, because there was no way to say "TypeScript exists as a concept but
// this person does not claim it".
//
// So the two are split. This file is the DICTIONARY: every skill the system
// can recognise, its aliases, and a sensible default weight. A user's profile
// (lib/domain/scoring/profile.ts) is a SUBSET of these names with their own
// weights, extracted from their resume and editable by them.
//
// Adding an entry here makes a skill recognisable to everyone's extractor. It
// does not, on its own, credit anybody with it.
// ---------------------------------------------------------------------------

export type TaxonomySkill = {
  name: string;
  /** Default weight when a resume claims this skill and the user has not tuned it. */
  weight: number;
  aliases?: string[];
  /**
   * True for entries added to widen RECOGNITION without widening the default
   * profile. See DEFAULT_PROFILE_SKILLS below for why the distinction has to
   * exist at all — it is not cosmetic.
   */
  extended?: true;
};

/**
 * Weights roughly track how much signal the skill carries in this market
 * rather than how hard it is: the agentic-AI cluster is weighted highest
 * because it is the scarcest and most differentiating, not the most advanced.
 */
export const SKILL_TAXONOMY: TaxonomySkill[] = [
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

  // Agentic AI cluster — the scarcest signal in this market.
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

  { name: "express.js", weight: 2, aliases: ["express"] },
  // Skills match on whole tokens (see tokenPattern in score.ts), so "sql" does
  // not fire inside "postgresql" or "mysql". Those two are handled on purpose
  // and differently:
  //   - postgresql has its own weighted entry below, so crediting "sql" as
  //     well would count one piece of evidence twice. Left unaliased.
  //   - mysql has no entry of its own and is unambiguously SQL work, so it is
  //     listed here rather than being silently dropped.
  { name: "sql", weight: 2, aliases: ["mysql"] },
  { name: "python", weight: 2 },
  { name: "docker", weight: 2 },
  { name: "aws s3", weight: 1 },
  { name: "aws lambda", weight: 1, aliases: ["serverless"] },
  { name: "iis", weight: 1 },
  { name: "vitest", weight: 2, aliases: ["unit testing", "integration testing"] },
  { name: "vector search", weight: 3, aliases: ["faiss", "pgvector", "vector database"] },
  { name: "postgresql", weight: 2, aliases: ["postgres"] },
  { name: "sqlite", weight: 1 },
  { name: "react native", weight: 1 },
  { name: "machine learning", weight: 1, aliases: ["ml"] },

  // --- Recognised for colleagues, not present in the default profile -------
  // The taxonomy is everyone's dictionary, so it has to cover stacks the first
  // user does not have. `extended` keeps them OUT of DEFAULT_PROFILE_SKILLS —
  // see the note there; adding them to the default would quietly depress every
  // score in the system.
  { name: "vue", weight: 3, aliases: ["vue.js", "vuejs", "nuxt"], extended: true },
  { name: "angular", weight: 3, aliases: ["angularjs"], extended: true },
  { name: "svelte", weight: 2, aliases: ["sveltekit"], extended: true },
  { name: "java", weight: 3, aliases: ["spring", "spring boot"], extended: true },
  { name: "kotlin", weight: 2, extended: true },
  { name: "swift", weight: 2, aliases: ["swiftui", "ios"], extended: true },
  { name: "go", weight: 3, aliases: ["golang"], extended: true },
  { name: "rust", weight: 3, extended: true },
  { name: "ruby", weight: 2, aliases: ["rails", "ruby on rails"], extended: true },
  { name: "php", weight: 2, aliases: ["laravel"], extended: true },
  { name: "c#", weight: 2, aliases: [".net", "dotnet", "asp.net"], extended: true },
  { name: "django", weight: 2, extended: true },
  { name: "fastapi", weight: 2, extended: true },
  { name: "graphql", weight: 2, aliases: ["apollo"], extended: true },
  { name: "kubernetes", weight: 2, aliases: ["k8s"], extended: true },
  { name: "terraform", weight: 2, extended: true },
  { name: "redis", weight: 1, extended: true },
  { name: "kafka", weight: 2, extended: true },
  { name: "elasticsearch", weight: 2, extended: true },
  { name: "figma", weight: 1, extended: true },
];

/**
 * The starting profile for a user who has not uploaded a resume yet.
 *
 * NOT the whole taxonomy, and this is the subtle part. scoreJob normalises
 * against the sum of the profile's own skill weights (see FULL_CREDIT_FRACTION
 * in score.ts), so every skill added to a profile makes the denominator bigger
 * and every score smaller. Seeding a new user with all ~67 recognised skills —
 * a set nobody actually has — would push the whole list below MATCH_THRESHOLD
 * and quietly stop anything being drafted at all.
 *
 * So the default stays the original, coherent full-stack/AI profile: a
 * plausible starting point that ranks sensibly on day one, which the user's own
 * resume then narrows. The `extended` entries exist so that a colleague whose
 * resume says "Go" or "Spring Boot" gets credited for it — recognition, not
 * assumption.
 */
export const DEFAULT_PROFILE_SKILLS: TaxonomySkill[] = SKILL_TAXONOMY.filter(
  (s) => !s.extended
);

/** Job titles the default profile targets. Narrower than the vocabulary. */
export const DEFAULT_TARGET_ROLES = [
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

/** Every recognised skill name, for the extractor and the profile editor. */
export const TAXONOMY_NAMES: string[] = SKILL_TAXONOMY.map((s) => s.name);

export function findTaxonomySkill(name: string): TaxonomySkill | undefined {
  const needle = name.trim().toLowerCase();
  return SKILL_TAXONOMY.find((s) => s.name === needle);
}

/**
 * Job titles the extractor knows how to recognise, and the default target list
 * for a profile that has none. Broader than one person's targets on purpose —
 * this is a dictionary, not a preference.
 */
export const TARGET_ROLE_VOCABULARY = [
  "full stack developer",
  "full stack engineer",
  "software engineer",
  "software developer",
  "frontend engineer",
  "front end developer",
  "backend engineer",
  "back end developer",
  "react developer",
  "next.js developer",
  "node.js developer",
  "flutter developer",
  "mobile developer",
  "android developer",
  "ios developer",
  "ai engineer",
  "agentic ai engineer",
  "llm engineer",
  "applied ai engineer",
  "machine learning engineer",
  "data engineer",
  "devops engineer",
  "platform engineer",
  "founding engineer",
];

// ---------------------------------------------------------------------------
// POLICY, not matching. Shared across every user.
//
// Target roles are matched as an ordered subsequence of the title's words, so
// "Software Sales Engineer" satisfies "software engineer" exactly the way
// "Node.js Backend Developer" satisfies "node.js developer" — one interposed
// word in both cases. No tokenising rule can separate them; the only thing that
// distinguishes the two is knowing that "sales" is not an engineering job.
//
// Every phrase below names a role that speaks engineering vocabulary while not
// being an engineering job. A veto phrase anywhere in the title is FATAL: the
// job scores 0 and cannot clear any threshold, however much React its
// description name-drops.
//
// It has to be fatal rather than a deduction. These postings never earned the
// target-role bonus in the first place, so withholding it was a no-op for
// exactly the titles this list exists to stop — a "Technical Recruiter" advert
// listing React, TypeScript and Node.js scored 46 on skill evidence alone and
// sailed into the apply queue.
//
// This list is intentionally narrow. Roles that are arguably engineering-
// adjacent — Developer Advocate, QA Engineer, Technical Writer, Product
// Manager, DevOps Engineer — are deliberately NOT here. Whether those are worth
// applying to is each person's call, and a profile may add its own vetoes.
//
// Because a veto is fatal, the guarantee that it suppresses no entry in
// TARGET_ROLE_VOCABULARY is load-bearing. Tests enforce it.
export const ROLE_VETO_PHRASES = [
  "sales",
  "marketing",
  "recruiter",
  "recruiting",
  "account executive",
  "business development",
  "customer success",
  "solutions consultant",
];

/** Contract/freelance keywords used when scoring `leads`. */
export const CONTRACT_KEYWORDS = [
  "react", "next.js", "nextjs", "typescript", "node", "flutter",
  "ai agent", "llm", "rag", "chatbot", "automation", "mvp", "full stack",
];
