CREATE TABLE `app_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`values` text,
	`updated_by_user_id` integer,
	`updated_at` integer DEFAULT (unixepoch())
);
