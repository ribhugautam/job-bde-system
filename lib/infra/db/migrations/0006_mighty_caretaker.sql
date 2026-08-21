CREATE TABLE `user_mail` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`smtp_user` text NOT NULL,
	`smtp_password_encrypted` text NOT NULL,
	`from_name` text,
	`smtp_host` text DEFAULT 'smtp.gmail.com' NOT NULL,
	`smtp_port` integer DEFAULT 465 NOT NULL,
	`verified_at` integer,
	`last_error` text,
	`updated_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
ALTER TABLE `applications` ADD `user_id` integer;--> statement-breakpoint
CREATE INDEX `applications_user_id_idx` ON `applications` (`user_id`);--> statement-breakpoint
ALTER TABLE `outreach` ADD `user_id` integer;--> statement-breakpoint
CREATE INDEX `outreach_user_id_idx` ON `outreach` (`user_id`);