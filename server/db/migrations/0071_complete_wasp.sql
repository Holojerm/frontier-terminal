CREATE TABLE `forward_call_scores` (
	`id` text PRIMARY KEY NOT NULL,
	`call_id` text NOT NULL,
	`method` text NOT NULL,
	`control` integer NOT NULL,
	`estimate` real NOT NULL,
	`low` real,
	`high` real,
	`actual` real NOT NULL,
	`error_pct` real NOT NULL,
	`in_method_range` integer,
	`in_call_range` integer NOT NULL,
	`concept` text NOT NULL,
	`form` text NOT NULL,
	`filed` text NOT NULL,
	`accession_no` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `forward_call_scores_call_idx` ON `forward_call_scores` (`call_id`);--> statement-breakpoint
CREATE TABLE `forward_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`rule` text NOT NULL,
	`kind` text NOT NULL,
	`ticker` text NOT NULL,
	`metric` text NOT NULL,
	`fiscal_year` integer NOT NULL,
	`fiscal_quarter` integer,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`label` text NOT NULL,
	`resolves_from` text NOT NULL,
	`methods` text NOT NULL,
	`inputs` text NOT NULL,
	`note` text NOT NULL,
	`recorded_at` text NOT NULL,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `forward_calls_target_idx` ON `forward_calls` (`ticker`,`metric`,`period_end`);--> statement-breakpoint
CREATE INDEX `forward_calls_recorded_idx` ON `forward_calls` (`recorded_at`);