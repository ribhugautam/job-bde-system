CREATE TABLE `applications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`cover_letter` text NOT NULL,
	`emphasized_skills` text DEFAULT '[]',
	`generated_by` text DEFAULT 'template' NOT NULL,
	`send_mode` text NOT NULL,
	`sent_at` integer,
	`sent_to` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`error` text,
	`message_id` text,
	`responded_at` integer,
	`follow_up_count` integer DEFAULT 0 NOT NULL,
	`last_follow_up_at` integer,
	`next_follow_up_at` integer,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE INDEX `applications_job_id_idx` ON `applications` (`job_id`);--> statement-breakpoint
CREATE INDEX `applications_message_id_idx` ON `applications` (`message_id`);--> statement-breakpoint
CREATE INDEX `applications_next_follow_up_idx` ON `applications` (`next_follow_up_at`);--> statement-breakpoint
CREATE TABLE `digest_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_at` integer DEFAULT (unixepoch()),
	`new_jobs` integer DEFAULT 0,
	`new_leads` integer DEFAULT 0,
	`duplicates_merged` integer DEFAULT 0,
	`jobs_enriched` integer DEFAULT 0,
	`applications_auto_sent` integer DEFAULT 0,
	`applications_queued` integer DEFAULT 0,
	`outreach_auto_sent` integer DEFAULT 0,
	`outreach_queued` integer DEFAULT 0,
	`replies_detected` integer DEFAULT 0,
	`follow_ups_sent` integer DEFAULT 0,
	`budget_exhausted` integer DEFAULT false,
	`errors` text DEFAULT '[]',
	`summary` text
);
--> statement-breakpoint
CREATE TABLE `documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text DEFAULT 'resume' NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text DEFAULT 'application/pdf' NOT NULL,
	`size_bytes` integer NOT NULL,
	`content_base64` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`uploaded_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`source_id` text NOT NULL,
	`title` text NOT NULL,
	`company` text NOT NULL,
	`company_url` text,
	`url` text NOT NULL,
	`apply_email` text,
	`location` text,
	`remote` integer DEFAULT true,
	`salary_text` text,
	`tags` text DEFAULT '[]',
	`description` text,
	`posted_at` integer,
	`fetched_at` integer DEFAULT (unixepoch()),
	`fingerprint` text,
	`sources` text DEFAULT '[]',
	`description_source` text,
	`score` integer DEFAULT 0,
	`score_reasons` text DEFAULT '[]',
	`status` text DEFAULT 'found' NOT NULL,
	`stage` text DEFAULT 'enrich' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`next_attempt_at` integer,
	`created_at` integer DEFAULT (unixepoch()),
	`updated_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_source_source_id_uq` ON `jobs` (`source`,`source_id`);--> statement-breakpoint
CREATE INDEX `jobs_fingerprint_idx` ON `jobs` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `jobs_stage_next_attempt_idx` ON `jobs` (`stage`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`);--> statement-breakpoint
CREATE TABLE `leads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`source_id` text NOT NULL,
	`title` text NOT NULL,
	`client_or_company` text,
	`url` text NOT NULL,
	`contact_email` text,
	`budget_text` text,
	`description` text,
	`posted_at` integer,
	`fetched_at` integer DEFAULT (unixepoch()),
	`fingerprint` text,
	`sources` text DEFAULT '[]',
	`score` integer DEFAULT 0,
	`score_reasons` text DEFAULT '[]',
	`status` text DEFAULT 'found' NOT NULL,
	`stage` text DEFAULT 'score' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`next_attempt_at` integer,
	`created_at` integer DEFAULT (unixepoch()),
	`updated_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `leads_source_source_id_uq` ON `leads` (`source`,`source_id`);--> statement-breakpoint
CREATE INDEX `leads_fingerprint_idx` ON `leads` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `leads_stage_next_attempt_idx` ON `leads` (`stage`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `leads_status_idx` ON `leads` (`status`);--> statement-breakpoint
CREATE TABLE `linkedin_enrich_cache` (
	`job_id` text PRIMARY KEY NOT NULL,
	`description` text,
	`outcome` text NOT NULL,
	`http_status` integer,
	`fetched_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE TABLE `outreach` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lead_id` integer NOT NULL,
	`pitch` text NOT NULL,
	`generated_by` text DEFAULT 'template' NOT NULL,
	`send_mode` text NOT NULL,
	`sent_at` integer,
	`sent_to` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`error` text,
	`message_id` text,
	`responded_at` integer,
	`follow_up_count` integer DEFAULT 0 NOT NULL,
	`last_follow_up_at` integer,
	`next_follow_up_at` integer,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE INDEX `outreach_lead_id_idx` ON `outreach` (`lead_id`);--> statement-breakpoint
CREATE INDEX `outreach_message_id_idx` ON `outreach` (`message_id`);--> statement-breakpoint
CREATE INDEX `outreach_next_follow_up_idx` ON `outreach` (`next_follow_up_at`);