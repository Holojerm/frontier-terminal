CREATE TABLE `price_readings` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`confirmed` integer NOT NULL,
	`changed` integer NOT NULL,
	`readings` text NOT NULL,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL,
	`read_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `price_readings_source_idx` ON `price_readings` (`source_id`,`read_at`);