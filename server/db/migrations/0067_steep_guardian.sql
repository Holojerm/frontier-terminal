CREATE TABLE `ercot_large_load_facts` (
	`id` text PRIMARY KEY NOT NULL,
	`report_url` text NOT NULL,
	`metric` text NOT NULL,
	`period` text NOT NULL,
	`value` real NOT NULL,
	`qualifier` text,
	`horizon` text,
	`quote` text NOT NULL,
	`posted` text NOT NULL,
	`raw_key` text NOT NULL,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ercot_large_load_facts_metric_idx` ON `ercot_large_load_facts` (`metric`,`period`);--> statement-breakpoint
CREATE TABLE `ercot_large_load_reports` (
	`url` text PRIMARY KEY NOT NULL,
	`series` text NOT NULL,
	`title` text NOT NULL,
	`posted` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`facts` integer NOT NULL,
	`raw_key` text,
	`read_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `grid_load_days` (
	`ba` text NOT NULL,
	`date` text NOT NULL,
	`mwh` real NOT NULL,
	`hours` integer NOT NULL,
	`raw_key` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`ba`, `date`)
);
--> statement-breakpoint
CREATE TABLE `grid_load_files` (
	`period` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`etag` text,
	`content_hash` text,
	`days` integer NOT NULL,
	`raw_key` text,
	`read_at` text NOT NULL
);
