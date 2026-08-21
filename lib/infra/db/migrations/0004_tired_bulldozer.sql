CREATE TABLE `user_profiles` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`skills` text,
	`target_roles` text,
	`veto_phrases` text,
	`career_start` integer,
	`accepted_arrangements` text,
	`source_document_id` integer,
	`auto_extracted` integer DEFAULT true NOT NULL,
	`updated_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
ALTER TABLE `documents` ADD `user_id` integer;