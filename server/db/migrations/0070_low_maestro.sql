CREATE TABLE `listed_hiring_reads` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`ticker` text NOT NULL,
	`read_at` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`total` integer,
	`datacenter` integer,
	`infrastructure` integer,
	`added` integer,
	`closed` integer,
	`content_hash` text,
	`raw_key` text,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `listed_hiring_reads_board_read_idx` ON `listed_hiring_reads` (`board_id`,`read_at`);--> statement-breakpoint
CREATE TABLE `listed_jobs` (
	`board_id` text NOT NULL,
	`job_id` text NOT NULL,
	`ticker` text NOT NULL,
	`title` text NOT NULL,
	`department` text,
	`location` text,
	`published_at` text,
	`role_class` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`closed_at` text,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`board_id`, `job_id`)
);
--> statement-breakpoint
CREATE INDEX `listed_jobs_board_closed_idx` ON `listed_jobs` (`board_id`,`closed_at`);