CREATE TABLE `archive_captures` (
	`id` text PRIMARY KEY NOT NULL,
	`era` text NOT NULL,
	`provider` text NOT NULL,
	`original_url` text NOT NULL,
	`captured_at` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`content_hash` text,
	`raw_key` text,
	`bytes` integer,
	`rows` integer NOT NULL,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `archive_captures_provider_idx` ON `archive_captures` (`provider`,`status`,`captured_at`);--> statement-breakpoint
CREATE TABLE `archived_prices` (
	`id` text PRIMARY KEY NOT NULL,
	`capture_id` text NOT NULL,
	`entity_key` text NOT NULL,
	`provider` text NOT NULL,
	`content_hash` text NOT NULL,
	`payload` text NOT NULL,
	`captured_at` text NOT NULL,
	`original_url` text NOT NULL,
	`basis` text NOT NULL,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `archived_prices_key_idx` ON `archived_prices` (`entity_key`,`captured_at`);--> statement-breakpoint
CREATE INDEX `archived_prices_captured_id_idx` ON `archived_prices` (`captured_at`,`id`);