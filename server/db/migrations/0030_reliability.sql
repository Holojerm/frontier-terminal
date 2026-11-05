CREATE TABLE `deploy_checks` (
	`run_id` text PRIMARY KEY NOT NULL,
	`head_sha` text NOT NULL,
	`status` text NOT NULL,
	`conclusion` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`html_url` text NOT NULL,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `deploy_checks_created_idx` ON `deploy_checks` (`created_at`);--> statement-breakpoint
CREATE TABLE `filing_detections` (
	`accession_no` text PRIMARY KEY NOT NULL,
	`cik` text NOT NULL,
	`form` text,
	`alert_id` text NOT NULL,
	`rule` text NOT NULL,
	`headline` text NOT NULL,
	`alerted_at` text NOT NULL,
	`status` text NOT NULL,
	`accepted_at` text,
	`filing_date` text,
	`basis` text,
	`snapshot_id` text,
	`source_url` text,
	`fetched_at` text,
	`recorded_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `filing_detections_alerted_idx` ON `filing_detections` (`alerted_at`);--> statement-breakpoint
CREATE TABLE `poll_ticks` (
	`scope` text NOT NULL,
	`started_at` text NOT NULL,
	`runs` integer NOT NULL,
	`good` integer NOT NULL,
	PRIMARY KEY(`scope`, `started_at`)
);
--> statement-breakpoint
CREATE INDEX `poll_ticks_started_idx` ON `poll_ticks` (`started_at`);--> statement-breakpoint
CREATE TABLE `source_run_days` (
	`source_id` text NOT NULL,
	`day` text NOT NULL,
	`runs` integer NOT NULL,
	`good` integer NOT NULL,
	`first_good_at` text,
	`last_good_at` text,
	`last_run_at` text NOT NULL,
	`longest_gap_ms` integer,
	`gap_from` text,
	`gap_to` text,
	`rolled_at` text NOT NULL,
	PRIMARY KEY(`source_id`, `day`)
);
--> statement-breakpoint
CREATE INDEX `source_run_days_day_idx` ON `source_run_days` (`day`);