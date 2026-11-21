CREATE TABLE `archived_incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`incident_id` text NOT NULL,
	`title` text NOT NULL,
	`impact` text,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`resolved_at` text,
	`components` text NOT NULL,
	`incident_url` text NOT NULL,
	`capture_id` text NOT NULL,
	`captured_at` text NOT NULL,
	`first_captured_at` text NOT NULL,
	`original_url` text NOT NULL,
	`basis` text NOT NULL,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `archived_incidents_provider_idx` ON `archived_incidents` (`provider`,`started_at`);--> statement-breakpoint
CREATE INDEX `archived_incidents_captured_id_idx` ON `archived_incidents` (`captured_at`,`id`);--> statement-breakpoint
ALTER TABLE `archive_captures` ADD `covers_from` text;