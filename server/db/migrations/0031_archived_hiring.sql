CREATE TABLE `archived_hiring` (
	`id` text PRIMARY KEY NOT NULL,
	`capture_id` text NOT NULL,
	`provider` text NOT NULL,
	`scope` text NOT NULL,
	`label` text,
	`department_id` text,
	`department` text,
	`open_roles` integer NOT NULL,
	`captured_at` text NOT NULL,
	`original_url` text NOT NULL,
	`basis` text NOT NULL,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `archived_hiring_provider_idx` ON `archived_hiring` (`provider`,`scope`,`captured_at`);--> statement-breakpoint
CREATE INDEX `archived_hiring_captured_id_idx` ON `archived_hiring` (`captured_at`,`id`);--> statement-breakpoint
ALTER TABLE `archive_captures` ADD `axis` text DEFAULT 'pricing' NOT NULL;