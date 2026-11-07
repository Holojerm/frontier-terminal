CREATE TABLE `gkg_backfills` (
	`alert_id` text PRIMARY KEY NOT NULL,
	`through_stamp` text NOT NULL,
	`covered` integer NOT NULL,
	`candidates` integer NOT NULL,
	`recorded_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gkg_mentions` (
	`record_id` text PRIMARY KEY NOT NULL,
	`stamp` text NOT NULL,
	`seen_at` text NOT NULL,
	`outlet` text NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`names` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `gkg_mentions_seen_idx` ON `gkg_mentions` (`seen_at`);--> statement-breakpoint
ALTER TABLE `gdelt_files` ADD `mentions` integer;