CREATE TABLE `job_user_state` (
	`user_id` integer NOT NULL,
	`job_id` integer NOT NULL,
	`status` text NOT NULL,
	`triaged_at` integer DEFAULT (unixepoch()),
	`updated_at` integer DEFAULT (unixepoch()),
	PRIMARY KEY(`user_id`, `job_id`)
);
--> statement-breakpoint
CREATE INDEX `job_user_state_user_status_idx` ON `job_user_state` (`user_id`,`status`);