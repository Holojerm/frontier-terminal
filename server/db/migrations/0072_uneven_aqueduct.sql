CREATE TABLE `filed_text_facts` (
	`id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`cik` text NOT NULL,
	`lab` text NOT NULL,
	`metric` text NOT NULL,
	`start` text,
	`end` text NOT NULL,
	`value` real NOT NULL,
	`unit` text NOT NULL,
	`qualifier` text,
	`sentence` text NOT NULL,
	`form` text NOT NULL,
	`filed` text NOT NULL,
	`accession_no` text NOT NULL,
	`raw_key` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `filed_text_facts_series_idx` ON `filed_text_facts` (`ticker`,`metric`,`end`);--> statement-breakpoint
CREATE INDEX `filed_text_facts_filed_idx` ON `filed_text_facts` (`filed`,`id`);--> statement-breakpoint
CREATE TABLE `archived_rate_limits` (
	`id` text PRIMARY KEY NOT NULL,
	`capture_id` text NOT NULL,
	`provider` text NOT NULL,
	`recipe_id` text NOT NULL,
	`key` text NOT NULL,
	`model` text NOT NULL,
	`tier` text NOT NULL,
	`metric` text NOT NULL,
	`value` real,
	`payload` text NOT NULL,
	`captured_at` text NOT NULL,
	`original_url` text NOT NULL,
	`basis` text NOT NULL,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `archived_rate_limits_key_idx` ON `archived_rate_limits` (`recipe_id`,`key`,`captured_at`);--> statement-breakpoint
CREATE INDEX `archived_rate_limits_captured_id_idx` ON `archived_rate_limits` (`captured_at`,`id`);