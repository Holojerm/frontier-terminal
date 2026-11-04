CREATE TABLE `track_record_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`alert_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`snippet` text,
	`outlet` text NOT NULL,
	`url` text NOT NULL,
	`published_at` text NOT NULL,
	`search_id` text NOT NULL,
	`found_at` text NOT NULL,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `track_record_candidates_alert_idx` ON `track_record_candidates` (`alert_id`,`kind`,`published_at`);--> statement-breakpoint
CREATE INDEX `track_record_candidates_found_idx` ON `track_record_candidates` (`found_at`,`id`);--> statement-breakpoint
CREATE TABLE `track_record_searches` (
	`id` text PRIMARY KEY NOT NULL,
	`alert_id` text NOT NULL,
	`source` text NOT NULL,
	`query` text NOT NULL,
	`window_start` text NOT NULL,
	`window_end` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`candidates` integer NOT NULL,
	`searched_at` text NOT NULL,
	`raw_key` text,
	`source_url` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `track_record_searches_alert_idx` ON `track_record_searches` (`alert_id`,`source`,`searched_at`);--> statement-breakpoint
CREATE TABLE `track_record_verdicts` (
	`id` text PRIMARY KEY NOT NULL,
	`candidate_id` text NOT NULL,
	`alert_id` text NOT NULL,
	`same_event` integer NOT NULL,
	`rationale` text NOT NULL,
	`judged_at` text NOT NULL,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `track_record_verdicts_alert_idx` ON `track_record_verdicts` (`alert_id`);--> statement-breakpoint
CREATE INDEX `track_record_verdicts_judged_idx` ON `track_record_verdicts` (`judged_at`,`id`);