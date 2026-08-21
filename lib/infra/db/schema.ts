import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  primaryKey,
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
// USERS
//
// The deployment was single-user: one APP_PASSWORD unlocked everything, and
// there was no table here at all. Colleagues now have real accounts.
//
// Registration is invite-only by design — this app sits on a public URL and
// sends email on people's behalf, so "anyone who finds the login page" is not
// an acceptable population. See `invites` below.
// ---------------------------------------------------------------------------
export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // Stored lowercased and trimmed by lib/infra/db/users.ts. The unique index
    // is on the raw column, so normalising on the way in is what actually
    // prevents Alice@x.com and alice@x.com becoming two accounts.
    email: text("email").notNull(),
    name: text("name").notNull(),
    /**
     * Self-describing PBKDF2 string: `pbkdf2-sha256$<iterations>$<salt>$<hash>`.
     * One column rather than hash+salt+iterations, so the cost factor can be
     * raised without a migration. See lib/infra/crypto/password.ts.
     */
    passwordHash: text("password_hash").notNull(),
    // "admin" can invite and deactivate people; "member" cannot. Deliberately
    // two values and not a permission system — there are two things to decide.
    role: text("role").notNull().default("member"),
    /**
     * Deactivation is a flag, never a DELETE. Applications and outreach
     * reference a user, and those rows are a record of email that really was
     * sent to a real company; removing the sender would strand them.
     */
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    /**
     * Powers the "new since you last looked" marker on the job list. Updated on
     * each dashboard visit — this is the whole of the seen/unseen mechanism,
     * deliberately, instead of a per-user-per-job seen table.
     */
    lastSeenAt: integer("last_seen_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).default(
      sql`(unixepoch())`
    ),
    updatedAt: integer("updated_at", { mode: "timestamp" }).default(
      sql`(unixepoch())`
    ),
  },
  (t) => [uniqueIndex("users_email_uq").on(t.email)]
);

// ---------------------------------------------------------------------------
// INVITES — the only route to a new account.
//
// Single-use and expiring. The token is the credential, so it is generated with
// crypto.getRandomValues and never derived from the email.
// ---------------------------------------------------------------------------
export const invites = sqliteTable(
  "invites",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    token: text("token").notNull(),
    email: text("email").notNull(),
    role: text("role").notNull().default("member"),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    /** Set the moment it is redeemed. Non-null means spent — never reusable. */
    acceptedAt: integer("accepted_at", { mode: "timestamp" }),
    acceptedByUserId: integer("accepted_by_user_id"),
    createdByUserId: integer("created_by_user_id").notNull(),
    /** Revoked invites keep their row so an admin can see what was withdrawn. */
    revokedAt: integer("revoked_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).default(
      sql`(unixepoch())`
    ),
  },
  (t) => [
    uniqueIndex("invites_token_uq").on(t.token),
    index("invites_email_idx").on(t.email),
  ]
);

// ---------------------------------------------------------------------------
// USER PROFILES — what each person's job list is ranked against.
//
// This is the table that makes "no filters, ranked by MY resume" possible. The
// matcher used to read one person's skills straight out of a TypeScript module
// (lib/domain/scoring/resume-profile.ts), so there was exactly one ranking and
// it belonged to whoever wrote the file.
//
// Auto-populated from the uploaded resume PDF, then editable — extraction is
// heuristic and gets things wrong, so the user always outranks it.
// ---------------------------------------------------------------------------
export const userProfiles = sqliteTable("user_profiles", {
  // One row per user; the user id IS the key. A user cannot have two profiles.
  userId: integer("user_id").primaryKey(),

  /** [{ name, weight, aliases }] — a subset of lib/domain/scoring/taxonomy.ts. */
  skills: text("skills", { mode: "json" }).$type<
    { name: string; weight: number; aliases?: string[] }[]
  >(),
  targetRoles: text("target_roles", { mode: "json" }).$type<string[]>(),
  vetoPhrases: text("veto_phrases", { mode: "json" }).$type<string[]>(),

  /** Null means unknown, and experience adjustments are then skipped entirely. */
  careerStart: integer("career_start", { mode: "timestamp" }),

  /**
   * Which arrangements this person will actually take. This is where the
   * removed filter chips went: with no filter bar, "I don't want on-site" has
   * to live somewhere, and as a ranking input it lets an outstanding hybrid
   * role still out-rank a mediocre remote one rather than being hidden.
   */
  acceptedArrangements: text("accepted_arrangements", { mode: "json" })
    .$type<string[]>(),

  /** Which uploaded document this was extracted from, for "re-extract". */
  sourceDocumentId: integer("source_document_id"),
  /** True until the user edits, so the UI can say the values are unreviewed. */
  autoExtracted: integer("auto_extracted", { mode: "boolean" })
    .notNull()
    .default(true),

  updatedAt: integer("updated_at", { mode: "timestamp" }).default(
    sql`(unixepoch())`
  ),
});

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
    /**
     * NOT dead: `arrangement` is the source of truth for where a job is
     * worked from, but this column is still read in four places, so it
     * cannot simply be dropped. `lib/pipeline/stages/draft.ts` reads it
     * (`job.remote ?? undefined`, though nothing downstream in
     * `lib/domain/drafting/` currently consumes the field). `score.ts` reads
     * it. `scripts/reconcile-schema.ts` reads it to feed `fingerprintJob`.
     * `scripts/backfill-facts.ts` reads it to feed `deriveJobFacts`, where it
     * can decide `arrangement` when location and tags are both silent. Any
     * change here has to check all four call sites first.
     *
     * `.default(true)` is still present today, deliberately, not an oversight.
     * Dropping it was tried: it made drizzle-kit emit a libSQL `ALTER COLUMN`
     * plus a DROP/CREATE pass on all 16 indexes across four tables, instead of
     * a pure `ADD COLUMN` migration — a rebuild-shaped change this plan will
     * not risk against a live table holding 623 real rows for a column most
     * callers now only fall back to. So the default stayed, and the migration
     * that added `arrangement` and the rest of the structured-facts columns
     * stayed additive-only.
     *
     * Because the default is still live, any insert path that omits `remote`
     * will silently persist `true`. Every insert MUST pass an explicit value
     * for this column, including an explicit `null` when the arrangement is
     * unknown — that discipline, not this schema, is what actually stops the
     * bug this plan exists to eliminate (all 623 rows claiming remote). That
     * guarantee is carried by the insert paths (Task 7), not by this column.
     */
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

    // --- structured facts (lib/domain/facts) ------------------------------
    arrangement: text("arrangement"), // remote | hybrid | onsite | unknown
    geoEligibility: text("geo_eligibility"), // worldwide | eligible | restricted | unknown
    geoRegions: text("geo_regions", { mode: "json" }).$type<string[]>().default([]),
    minYears: integer("min_years"),
    maxYears: integer("max_years"),
    experienceText: text("experience_text"),
    easyApply: integer("easy_apply", { mode: "boolean" }),
    // Which extractor version produced the fields above. backfill-facts.ts
    // re-derives only rows below the current FACTS_VERSION.
    factsVersion: integer("facts_version").notNull().default(0),

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
    index("jobs_facts_idx").on(t.geoEligibility, t.arrangement, t.score),
    index("jobs_facts_version_idx").on(t.factsVersion),
  ]
);

// ---------------------------------------------------------------------------
// PER-USER SENDING IDENTITY.
//
// Before this, every email left through one GMAIL_USER mailbox and was signed
// with one person's name. A colleague applying to a job would have had their
// application arrive from somebody else's address, signed as somebody else —
// to a real company, under a real name. That is the failure this table exists
// to make impossible.
// ---------------------------------------------------------------------------
export const userMail = sqliteTable("user_mail", {
  userId: integer("user_id").primaryKey(),

  /** The address mail is sent FROM, and the SMTP username. */
  smtpUser: text("smtp_user").notNull(),
  /**
   * AES-256-GCM ciphertext — never the password itself. Encrypted with a key
   * derived from ENCRYPTION_KEY, deliberately NOT from AUTH_SECRET: rotating a
   * cookie-signing key must not silently destroy stored credentials. See
   * lib/infra/crypto/secret.ts.
   *
   * This value must never be returned to a client, logged, or included in any
   * API response. lib/infra/db/user-mail.ts is the only module that reads it.
   */
  smtpPasswordEncrypted: text("smtp_password_encrypted").notNull(),
  /** Display name on outgoing mail. Defaults to the user's name. */
  fromName: text("from_name"),

  smtpHost: text("smtp_host").notNull().default("smtp.gmail.com"),
  smtpPort: integer("smtp_port").notNull().default(465),

  /**
   * Set only once a real connection to the mail server has succeeded.
   *
   * AUTO-SEND IS GATED ON THIS, not on the row existing. A saved-but-untested
   * mailbox is exactly as likely to be a typo as a working setup, and the cost
   * of being wrong is an application that silently never arrives.
   */
  verifiedAt: integer("verified_at", { mode: "timestamp" }),
  lastError: text("last_error"),

  updatedAt: integer("updated_at", { mode: "timestamp" }).default(
    sql`(unixepoch())`
  ),
});

// ---------------------------------------------------------------------------
// PER-USER JOB STATE — the private half of a shared job pool.
//
// Everyone sees the same ingested jobs; what each person has DONE with one is
// theirs. A colleague dismissing a job never hides it from you.
//
// WRITTEN ONLY WHEN SOMEBODY ACTS. There is deliberately no row per user per
// job: absence means "untriaged", which is the overwhelmingly common case. That
// is what lets a new colleague sign in to a fully ranked inbox with nothing
// written for them, and what keeps this table proportional to actions taken
// rather than to users x jobs. See lib/domain/jobs/buckets.ts.
//
// `jobs.status` still exists and still belongs to the unattended pipeline,
// which runs one shared queue. The two are not the same axis: the pipeline's
// status is "what has the system done", this is "what has this person done".
// ---------------------------------------------------------------------------
export const jobUserState = sqliteTable(
  "job_user_state",
  {
    userId: integer("user_id").notNull(),
    jobId: integer("job_id").notNull(),
    /** One of JOB_STATUSES — see lib/pipeline/state.ts. */
    status: text("status").notNull(),
    /** Set when the person first triaged it, for their own audit trail. */
    triagedAt: integer("triaged_at", { mode: "timestamp" }).default(
      sql`(unixepoch())`
    ),
    updatedAt: integer("updated_at", { mode: "timestamp" }).default(
      sql`(unixepoch())`
    ),
  },
  (t) => [
    // Composite primary key: one state row per person per job, enforced by the
    // database rather than by every write path remembering to check.
    primaryKey({ columns: [t.userId, t.jobId] }),
    // The bucket queries all start "my rows", so this is the index they need.
    index("job_user_state_user_status_idx").on(t.userId, t.status),
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
    /**
     * Who applied. NULLABLE only because rows predate accounts — the migration
     * assigns those to the seeded admin, which is factually right since the
     * deployment had exactly one user when they were written.
     *
     * Load-bearing for correctness, not just attribution: it decides whose
     * mailbox the email leaves from and whose resume is attached.
     */
    userId: integer("user_id"),
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
    index("applications_user_id_idx").on(t.userId),
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
    /** Who is pitching. See the note on applications.userId. */
    userId: integer("user_id"),
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
    index("outreach_user_id_idx").on(t.userId),
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
  /**
   * Whose resume this is.
   *
   * NULLABLE, and it has to be: rows already existed when accounts were
   * introduced, and there is no correct value to invent for them at ALTER time.
   * The migration assigns them to the seeded admin, which is factually right —
   * they were uploaded when the deployment had exactly one user.
   *
   * Read paths treat a null userId as belonging to nobody rather than to
   * everybody. Falling back to "any active resume" would attach one person's CV
   * to another person's application, which is the single worst thing this
   * system could do.
   */
  userId: integer("user_id"),
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
  company: text("company"),
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
