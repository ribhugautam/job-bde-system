import { sql } from "drizzle-orm";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// SQLite notes (migrated from Postgres):
//   serial       -> integer primaryKey({ autoIncrement: true })
//   timestamp    -> integer({ mode: "timestamp" })  — stored as unix SECONDS
//   defaultNow() -> .default(sql`(unixepoch())`)    — seconds, matches the mode above
//   boolean      -> integer({ mode: "boolean" })    — stored as 0/1
//   jsonb        -> text({ mode: "json" })          — stored as a JSON string
// Drizzle maps all of these back to Date / boolean / string[] in TS, so calling
// code is unchanged.

// ---------------------------------------------------------------------------
// Full-time / part-time REMOTE JOBS pulled from job board sources
// ---------------------------------------------------------------------------
export const jobs = sqliteTable("jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  source: text("source").notNull(), // e.g. "remoteok", "remotive", "arbeitnow", "wwr", "himalayas"
  sourceId: text("source_id").notNull(), // id/url from the source, used for de-dupe
  title: text("title").notNull(),
  company: text("company").notNull(),
  companyUrl: text("company_url"),
  url: text("url").notNull(), // canonical apply/listing URL
  applyEmail: text("apply_email"), // set only if the listing itself publishes a plain apply-by-email address
  location: text("location"),
  remote: integer("remote", { mode: "boolean" }).default(true),
  salaryText: text("salary_text"),
  tags: text("tags", { mode: "json" }).$type<string[]>().default([]),
  description: text("description"),
  postedAt: integer("posted_at", { mode: "timestamp" }),
  fetchedAt: integer("fetched_at", { mode: "timestamp" }).default(
    sql`(unixepoch())`
  ),

  // matching
  score: integer("score").default(0), // 0-100 fit score against resume
  scoreReasons: text("score_reasons", { mode: "json" })
    .$type<string[]>()
    .default([]),

  // pipeline status
  status: text("status").notNull().default("found"),
  // found -> matched -> drafted -> ready_for_review -> sent -> responded -> interview -> offer -> rejected -> ignored

  createdAt: integer("created_at", { mode: "timestamp" }).default(
    sql`(unixepoch())`
  ),
  updatedAt: integer("updated_at", { mode: "timestamp" }).default(
    sql`(unixepoch())`
  ),
});

// ---------------------------------------------------------------------------
// Freelance / contract LEADS (Upwork RSS searches, contract-tagged job posts)
// ---------------------------------------------------------------------------
export const leads = sqliteTable("leads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  source: text("source").notNull(), // "upwork_rss", "arbeitnow_contract", "wwr_contract", "himalayas_contract"
  sourceId: text("source_id").notNull(),
  title: text("title").notNull(),
  clientOrCompany: text("client_or_company"),
  url: text("url").notNull(),
  contactEmail: text("contact_email"), // only when publicly published by the poster
  budgetText: text("budget_text"),
  description: text("description"),
  postedAt: integer("posted_at", { mode: "timestamp" }),
  fetchedAt: integer("fetched_at", { mode: "timestamp" }).default(
    sql`(unixepoch())`
  ),

  score: integer("score").default(0),
  scoreReasons: text("score_reasons", { mode: "json" })
    .$type<string[]>()
    .default([]),

  status: text("status").notNull().default("found"),
  // found -> matched -> pitched -> sent -> responded -> won -> lost -> ignored

  createdAt: integer("created_at", { mode: "timestamp" }).default(
    sql`(unixepoch())`
  ),
  updatedAt: integer("updated_at", { mode: "timestamp" }).default(
    sql`(unixepoch())`
  ),
});

// ---------------------------------------------------------------------------
// Applications generated for `jobs`
// ---------------------------------------------------------------------------
export const applications = sqliteTable("applications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: integer("job_id").notNull(),
  coverLetter: text("cover_letter").notNull(),
  emphasizedSkills: text("emphasized_skills", { mode: "json" })
    .$type<string[]>()
    .default([]),
  generatedBy: text("generated_by").notNull().default("template"), // "template" | "claude"
  sendMode: text("send_mode").notNull(), // "auto_email" | "manual_portal"
  sentAt: integer("sent_at", { mode: "timestamp" }),
  sentTo: text("sent_to"),
  status: text("status").notNull().default("draft"),
  // draft -> ready_for_review -> sent -> failed
  error: text("error"),
  createdAt: integer("created_at", { mode: "timestamp" }).default(
    sql`(unixepoch())`
  ),
});

// ---------------------------------------------------------------------------
// Outreach pitches generated for `leads`
// ---------------------------------------------------------------------------
export const outreach = sqliteTable("outreach", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  leadId: integer("lead_id").notNull(),
  pitch: text("pitch").notNull(),
  generatedBy: text("generated_by").notNull().default("template"),
  sendMode: text("send_mode").notNull(), // "auto_email" | "manual"
  sentAt: integer("sent_at", { mode: "timestamp" }),
  sentTo: text("sent_to"),
  status: text("status").notNull().default("draft"),
  error: text("error"),
  createdAt: integer("created_at", { mode: "timestamp" }).default(
    sql`(unixepoch())`
  ),
});

// ---------------------------------------------------------------------------
// Uploaded files (currently just the resume PDF), stored as base64 in the DB.
//
// Why the DB and not the filesystem: Vercel's function filesystem is read-only
// apart from /tmp, and /tmp is per-instance and wiped between invocations. An
// uploaded file written to disk would vanish before the cron job could read it.
// Committing the PDF to the repo instead would put a phone number and email
// into git history. base64 in SQLite sidesteps both.
//
// Exactly one row per `kind` should have isActive = true; saveResume() in
// lib/documents.ts enforces that.
// ---------------------------------------------------------------------------
export const documents = sqliteTable("documents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull().default("resume"), // "resume" for now
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull().default("application/pdf"),
  sizeBytes: integer("size_bytes").notNull(), // size of the DECODED file
  contentBase64: text("content_base64").notNull(),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  uploadedAt: integer("uploaded_at", { mode: "timestamp" }).default(
    sql`(unixepoch())`
  ),
});

// ---------------------------------------------------------------------------
// One row per daily cron run — powers the digest email + an audit trail
// ---------------------------------------------------------------------------
export const digestLogs = sqliteTable("digest_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runAt: integer("run_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
  newJobs: integer("new_jobs").default(0),
  newLeads: integer("new_leads").default(0),
  applicationsAutoSent: integer("applications_auto_sent").default(0),
  applicationsQueued: integer("applications_queued").default(0),
  outreachAutoSent: integer("outreach_auto_sent").default(0),
  outreachQueued: integer("outreach_queued").default(0),
  errors: text("errors", { mode: "json" }).$type<string[]>().default([]),
  summary: text("summary"),
});
