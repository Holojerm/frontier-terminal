CREATE TABLE `claim_readings` (
	`thesis_id` text NOT NULL,
	`claim_id` text NOT NULL,
	`date` text NOT NULL,
	`value` real NOT NULL,
	`detail` text NOT NULL,
	`computed_at` text NOT NULL,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`claim_id`, `date`)
);
--> statement-breakpoint
CREATE TABLE `claim_status_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`thesis_id` text NOT NULL,
	`claim_id` text NOT NULL,
	`status` text NOT NULL,
	`previous_status` text,
	`reading_date` text,
	`reason` text NOT NULL,
	`changed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `claim_status_changes_claim_idx` ON `claim_status_changes` (`claim_id`,`changed_at`);