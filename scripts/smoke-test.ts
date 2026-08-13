// One-off smoke test: exercises scoring, drafting, fingerprinting and a real DB
// round-trip against a local SQLite file. Sends no email and makes no network
// call.
//
// This complements the unit tests rather than duplicating them: `npm test`
// proves each module in isolation, this proves they still fit together against
// a real database and a real schema.
//
//   npm run db:migrate && npm run smoke
//
// Note the env is set BEFORE importing anything, because lib/config/env.ts
// memoises on first read.
process.env.DRY_RUN = process.env.DRY_RUN ?? "1";
process.env.CRON_SECRET = process.env.CRON_SECRET || "smoke-test-secret";
process.env.APP_PASSWORD = process.env.APP_PASSWORD || "smoke-test-password";
process.env.AUTH_SECRET = process.env.AUTH_SECRET || "smoke-test-auth-secret-value";
process.env.OUTREACH_DAILY_CAP = process.env.OUTREACH_DAILY_CAP || "5";

import { scoreJob, scoreLead } from "../lib/domain/scoring/score";
import { getDb, schema } from "../lib/infra/db/client";
import {
  generateCoverLetter,
  generatePitch,
  composeFollowUp,
} from "../lib/domain/drafting/compose";
import {
  fingerprintJob,
  pickRicherDescription,
} from "../lib/domain/dedupe/fingerprint";
import type { RawJob, RawLead } from "../lib/domain/types";

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

// The SAME vacancy as it would arrive from a second board: different source,
// different id, differently-formatted title and company, thinner description.
const sameJobFromAnotherBoard: RawJob = {
  source: "himalayas",
  sourceId: "smoketest-2",
  title: "Sr. Next.js / Agentic AI Engineer (Remote)",
  company: "Acme Remote Co.",
  url: "https://example.com/job/2",
  location: "Remote, Worldwide",
  remote: true,
  tags: ["react"],
  description: "Short blurb.",
};

const sampleLead: RawLead = {
  source: "wwr_contract",
  sourceId: "smoketest-lead-1",
  title: "Need a React + AI agent dev for a 4-week MVP",
  clientOrCompany: "Some Startup",
  url: "https://example.com/lead/1",
  contactEmail: "hiring@example.com",
  budgetText: "$3000-5000",
  description:
    "Looking for a full stack dev to build an AI agent MVP using Next.js and LLM automation.",
};

function check(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

async function main() {
  console.log("--- scoring ---");
  const jobScore = scoreJob(sampleJob);
  console.log("job score:", jobScore.score, jobScore.reasons);
  const leadScore = scoreLead(sampleLead);
  console.log("lead score:", leadScore.score, leadScore.reasons);

  console.log("\n--- cross-source dedupe ---");
  const fpA = fingerprintJob(sampleJob);
  const fpB = fingerprintJob(sameJobFromAnotherBoard);
  console.log("remoteok  fingerprint:", fpA);
  console.log("himalayas fingerprint:", fpB);
  check(
    fpA === fpB,
    "the same vacancy from two boards must produce one fingerprint - " +
      "otherwise it becomes two rows and two cover letters"
  );
  const richer = pickRicherDescription(
    sampleJob.description,
    sameJobFromAnotherBoard.description
  );
  check(
    richer === sampleJob.description,
    "merging must keep the richer description"
  );
  console.log("merged description keeps the longer text: ok");

  console.log("\n--- draft generation (template path, no API key) ---");
  const coverLetter = await generateCoverLetter(sampleJob);
  console.log(coverLetter.text.slice(0, 240), "...");
  console.log("[generatedBy]", coverLetter.generatedBy);
  check(
    coverLetter.generatedBy === "template",
    "expected the template path with no API key"
  );

  const pitch = await generatePitch(sampleLead);
  console.log("\n" + pitch.text.slice(0, 240), "...");

  console.log("\n--- follow-up composition ---");
  const nudge = composeFollowUp({
    kind: "application",
    step: 1,
    roleTitle: sampleJob.title,
    company: sampleJob.company,
    originalSubject: `Application: ${sampleJob.title}`,
    daysSince: 4,
  });
  console.log("subject:", nudge.subject);
  console.log(nudge.text);
  check(
    nudge.subject.startsWith("Re: ") && !nudge.subject.includes("Re: Re:"),
    "follow-up subject must carry exactly one Re: prefix"
  );

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
      fingerprint: fpA,
      sources: [sampleJob.source],
      descriptionSource: "source",
      score: jobScore.score,
      scoreReasons: jobScore.reasons,
      status: jobScore.score >= 40 ? "matched" : "found",
      stage: "draft",
    })
    .returning();
  console.log("inserted job id:", insertedJob.id, "status:", insertedJob.status);

  // The unique index is the real dedupe guarantee. Re-inserting the identical
  // row must be a no-op, which is what makes a retried cron run safe.
  const reinserted = await db
    .insert(schema.jobs)
    .values({
      ...sampleJob,
      fingerprint: fpA,
      status: "matched",
      stage: "draft",
    })
    .onConflictDoNothing()
    .returning({ id: schema.jobs.id });
  check(
    reinserted.length === 0,
    "re-inserting the same (source, source_id) must be a no-op - the unique " +
      "index is what makes ingest idempotent"
  );
  console.log("duplicate insert correctly ignored: ok");

  const [insertedLead] = await db
    .insert(schema.leads)
    .values({
      ...sampleLead,
      score: leadScore.score,
      scoreReasons: leadScore.reasons,
      status: leadScore.score >= 40 ? "matched" : "found",
      stage: "draft",
    })
    .returning();
  console.log("inserted lead id:", insertedLead.id);

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
  check(readBack.length === 1, `expected exactly 1 job row, got ${readBack.length}`);
  check(jobScore.score >= 40, "expected the sample job to score as a match");
  check(leadScore.score >= 40, "expected the sample lead to score as a match");

  console.log("\nSMOKE TEST PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
