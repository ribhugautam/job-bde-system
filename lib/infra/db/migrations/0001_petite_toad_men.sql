ALTER TABLE `jobs` ADD `arrangement` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `geo_eligibility` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `geo_regions` text DEFAULT '[]';--> statement-breakpoint
ALTER TABLE `jobs` ADD `min_years` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `max_years` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `experience_text` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `easy_apply` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `facts_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `jobs_facts_idx` ON `jobs` (`geo_eligibility`,`arrangement`,`score`);--> statement-breakpoint
CREATE INDEX `jobs_facts_version_idx` ON `jobs` (`facts_version`);