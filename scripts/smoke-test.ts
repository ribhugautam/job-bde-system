// One-off smoke test: exercises the scoring + insert logic against a real
// local Postgres using fake job/lead data (since this sandbox's network
// egress blocks the real job board APIs). Does NOT send real email.
//
// Run with: npx tsx scripts/smoke-test.ts
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/jobbde?sslmode=disable";
process.env.CRON_SECRET = process.env.CRON_SECRET || "test-secret";
process.env.OUTREACH_DAILY_CAP = process.env.OUTREACH_DAILY_CAP || "5";

import { scoreJob, scoreLead } from "../lib/matcher";
import { getDb, schema } from "../lib/db/client";
import { generateCoverLetter, generatePitch } from "../lib/drafts";
import type { RawJob, RawLead } from "../lib/sources/types";

const sampleJob: RawJob = {
  source: "remoteok",
  sourceId: "smoketest-1",
  title: "Senior Next.js / Agentic AI Engineer",
  company: "Acme Remote Co",
  url: "https://example.com/job/1",
  applyEmail: "jobs@example.com",
  location: "Remote (Worldwide)",
  remote: true,
  tags: ["react", "next.js", "typescript", "llm", "rag"],
  description:
    "We need a full-stack engineer with React, Next.js, TypeScript, Node.js experience, and hands-on LLM/RAG/multi-agent orchestration work. Remote, worldwide. Apply: jobs@example.com",
};

const sampleLead: RawLead = {
  source: "wwr_contract",
  sourceId: "smoketest-lead-1",
  title: "Need a React + AI agent dev for a 4-week MVP",
  clientOrCompany: "Some Startup",
  url: "https://example.com/lead/1",
  contactEmail: "hiring@example.com",
  budgetText: "$3000-5000",
  description: "Looking for a full stack dev to build an AI agent MVP using Next.js and LLM automation.",
};

async function main() {
  console.log("--- scoring ---");
  const jobScore = scoreJob(sampleJob);
  console.log("job score:", jobScore);
  const leadScore = scoreLead(sampleLead);
  console.log("lead score:", leadScore);

  console.log("\n--- draft generation (template fallback, no ANTHROPIC_API_KEY) ---");
  const coverLetter = await generateCoverLetter(sampleJob);
  console.log(coverLetter.text.slice(0, 300), "...\n[generatedBy]", coverLetter.generatedBy);

  const pitch = await generatePitch(sampleLead);
  console.log(pitch.text.slice(0, 300), "...\n[generatedBy]", pitch.generatedBy);

  console.log("\n--- DB round-trip ---");
  const db = getDb();
  await db.delete(schema.applications);
  await db.delete(schema.outreach);
  await db.delete(schema.jobs);
  await db.delete(schema.leads);
  await db.delete(schema.digestLogs);

  const [insertedJob] = await db
    .insert(schema.jobs)
    .values({
      ...sampleJob,
      score: jobScore.score,
      scoreReasons: jobScore.reasons,
      status: jobScore.score >= 40 ? "matched" : "found",
    })
    .returning();
  console.log("inserted job id:", insertedJob.id, "status:", insertedJob.status);

  const [insertedLead] = await db
    .insert(schema.leads)
    .values({
      ...sampleLead,
      score: leadScore.score,
      scoreReasons: leadScore.reasons,
      status: leadScore.score >= 40 ? "matched" : "found",
    })
    .returning();
  console.log("inserted lead id:", insertedLead.id, "status:", insertedLead.status);

  const [app] = await db
    .insert(schema.applications)
    .values({
      jobId: insertedJob.id,
      coverLetter: coverLetter.text,
      emphasizedSkills: coverLetter.emphasizedSkills,
      generatedBy: coverLetter.generatedBy,
      sendMode: "auto_email",
      status: "ready_for_review",
    })
    .returning();
  console.log("inserted application id:", app.id);

  const readBack = await db.select().from(schema.jobs);
  console.log("jobs table row count after insert:", readBack.length);

  if (jobScore.score < 40) throw new Error("expected sample job to score as a match");
  if (leadScore.score < 40) throw new Error("expected sample lead to score as a match");
  if (readBack.length !== 1) throw new Error("expected exactly 1 job row");

  console.log("\nSMOKE TEST PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
