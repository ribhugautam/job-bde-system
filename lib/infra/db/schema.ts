import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

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
export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    source: text("source").notNull(), // e.g. "remoteok", "remotive", "himalayas", "linkedin_alert"
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

    // --- cross-source identity -------------------------------------------
    // normalize(company) + normalize(title) + location bucket. Two boards
    // listing the same role collapse onto one row instead of producing two
    // scored entries and two cover letters. See lib/domain/dedupe.
    fingerprint: text("fingerprint"),
    // Every source that contributed to this row, in arrival order. The `source`
    // column stays as the first one seen so existing queries keep working.
    sources: text("sources", { mode: "json" }).$type<string[]>().default([]),
    // Where `description` actually came from: "source", "linkedin_public", or
    // "merged:<source>". Makes it possible to tell a genuinely empty posting
    // from one enrichment has not reached yet.
    descriptionSource: text("description_source"),

    // --- matching ----------------------------------------------------------
    score: integer("score").default(0), // 0-100 fit score against resume
    scoreReasons: text("score_reasons", { mode: "json" })
      .$type<string[]>()
      .default([]),

    // --- pipeline ----------------------------------------------------------
    // status: user-facing position. stage: what the worker does next.
    // See the note at the top of lib/pipeline/state.ts on why these are separate.
    status: text("status").notNull().default("found"),
    stage: text("stage").notNull().default("enrich"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp" }),

    createdAt: integer("created_at", { mode: "timestamp" }).default(
      sql`(unixepoch())`
    ),
    updatedAt: integer("updated_at", { mode: "timestamp" }).default(
      sql`(unixepoch())`
    ),
  },
  (t) => [
    // Makes ingest an idempotent INSERT .. ON CONFLICT DO NOTHING. This both
    // removes the old one-SELECT-per-listing N+1 and makes a retried run safe;
    // the previous application-level check was only correct because nothing
    // retried it.
    uniqueIndex("jobs_source_source_id_uq").on(t.source, t.sourceId),
    index("jobs_fingerprint_idx").on(t.fingerprint),
    // The worker's claim query.
    index("jobs_stage_next_attempt_idx").on(t.stage, t.nextAttemptAt),
    index("jobs_status_idx").on(t.status),
  ]
);

// ---------------------------------------------------------------------------
// Freelance / contract LEADS (Upwork RSS searches, contract-tagged job posts)
// ---------------------------------------------------------------------------
export const leads = sqliteTable(
  "leads",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    source: text("source").notNull(), // "upwork_rss", "arbeitnow_contract", "wwr_contract"
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

    fingerprint: text("fingerprint"),
    sources: text("sources", { mode: "json" }).$type<string[]>().default([]),

    score: integer("score").default(0),
    scoreReasons: text("score_reasons", { mode: "json" })
      .$type<string[]>()
      .default([]),

    status: text("status").notNull().default("found"),
    stage: text("stage").notNull().default("score"), // leads have no enrich step
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp" }),

    createdAt: integer("created_at", { mode: "timestamp" }).default(
      sql`(unixepoch())`
    ),
    updatedAt: integer("updated_at", { mode: "timestamp" }).default(
      sql`(unixepoch())`
    ),
  },
  (t) => [
    uniqueIndex("leads_source_source_id_uq").on(t.source, t.sourceId),
    index("leads_fingerprint_idx").on(t.fingerprint),
    index("leads_stage_next_attempt_idx").on(t.stage, t.nextAttemptAt),
    index("leads_status_idx").on(t.status),
  ]
);

// ---------------------------------------------------------------------------
// Applications generated for `jobs`
// ---------------------------------------------------------------------------
export const applications = sqliteTable(
  "applications",
  {
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
    // draft -> ready_for_review -> sent -> responded | failed
    error: text("error"),

    // --- reply tracking ----------------------------------------------------
    // The RFC 5322 Message-ID nodemailer returns at send time. Inbound mail is
    // matched by checking In-Reply-To / References against this — an exact
    // match, not a sender-address heuristic, so a reply that arrives from a
    // different address on the same thread is still attributed correctly.
    messageId: text("message_id"),
    respondedAt: integer("responded_at", { mode: "timestamp" }),

    // --- follow-ups --------------------------------------------------------
    followUpCount: integer("follow_up_count").notNull().default(0),
    lastFollowUpAt: integer("last_follow_up_at", { mode: "timestamp" }),
    // Null means no follow-up is scheduled: either none is due yet, the thread
    // got a reply, or the sequence is finished.
    nextFollowUpAt: integer("next_follow_up_at", { mode: "timestamp" }),

    createdAt: integer("created_at", { mode: "timestamp" }).default(
      sql`(unixepoch())`
    ),
  },
  (t) => [
    index("applications_job_id_idx").on(t.jobId),
    index("applications_message_id_idx").on(t.messageId),
    index("applications_next_follow_up_idx").on(t.nextFollowUpAt),
  ]
);

// ---------------------------------------------------------------------------
// Outreach pitches generated for `leads`
// ---------------------------------------------------------------------------
export const outreach = sqliteTable(
  "outreach",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    leadId: integer("lead_id").notNull(),
    pitch: text("pitch").notNull(),
    generatedBy: text("generated_by").notNull().default("template"),
    sendMode: text("send_mode").notNull(), // "auto_email" | "manual"
    sentAt: integer("sent_at", { mode: "timestamp" }),
    sentTo: text("sent_to"),
    status: text("status").notNull().default("draft"),
    error: text("error"),

    messageId: text("message_id"),
    respondedAt: integer("responded_at", { mode: "timestamp" }),

    followUpCount: integer("follow_up_count").notNull().default(0),
    lastFollowUpAt: integer("last_follow_up_at", { mode: "timestamp" }),
    nextFollowUpAt: integer("next_follow_up_at", { mode: "timestamp" }),

    createdAt: integer("created_at", { mode: "timestamp" }).default(
      sql`(unixepoch())`
    ),
  },
  (t) => [
    index("outreach_lead_id_idx").on(t.leadId),
    index("outreach_message_id_idx").on(t.messageId),
    index("outreach_next_follow_up_idx").on(t.nextFollowUpAt),
  ]
);

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
// lib/infra/db/documents.ts enforces that.
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
// Permanent cache of LinkedIn public-page enrichment results.
//
// Keyed by LinkedIn job id and kept even on failure, so a posting that has been
// taken down (410) or refused (429/403) is not re-fetched on every run. This is
// what keeps the daily request count proportional to *new* alerts rather than
// to the size of the backlog.
// ---------------------------------------------------------------------------
export const linkedinEnrichCache = sqliteTable("linkedin_enrich_cache", {
  jobId: text("job_id").primaryKey(), // the numeric id from /jobs/view/{id}
  description: text("description"),
  outcome: text("outcome").notNull(), // "ok" | "not_found" | "blocked" | "error"
  httpStatus: integer("http_status"),
  fetchedAt: integer("fetched_at", { mode: "timestamp" }).default(
    sql`(unixepoch())`
  ),
});

// ---------------------------------------------------------------------------
// One row per worker run — powers the digest email + an audit trail
// ---------------------------------------------------------------------------
export const digestLogs = sqliteTable("digest_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runAt: integer("run_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
  newJobs: integer("new_jobs").default(0),
  newLeads: integer("new_leads").default(0),
  duplicatesMerged: integer("duplicates_merged").default(0),
  jobsEnriched: integer("jobs_enriched").default(0),
  applicationsAutoSent: integer("applications_auto_sent").default(0),
  applicationsQueued: integer("applications_queued").default(0),
  outreachAutoSent: integer("outreach_auto_sent").default(0),
  outreachQueued: integer("outreach_queued").default(0),
  repliesDetected: integer("replies_detected").default(0),
  followUpsSent: integer("follow_ups_sent").default(0),
  // True when the worker hit its wall-clock budget with work still queued —
  // the signal that the cron cadence is too slow for the volume.
  budgetExhausted: integer("budget_exhausted", { mode: "boolean" }).default(
    false
  ),
  errors: text("errors", { mode: "json" }).$type<string[]>().default([]),
  summary: text("summary"),
});
