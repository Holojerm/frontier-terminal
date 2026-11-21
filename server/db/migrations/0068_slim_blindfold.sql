CREATE TABLE `hardware_prints` (
	`id` text PRIMARY KEY NOT NULL,
	`series` text NOT NULL,
	`entity` text NOT NULL,
	`ticker` text,
	`period` text NOT NULL,
	`window` text NOT NULL,
	`value` real NOT NULL,
	`currency` text NOT NULL,
	`yoy_pct` real,
	`observed_as` text NOT NULL,
	`vintage` integer NOT NULL,
	`first_seen_at` text NOT NULL,
	`published_at` text,
	`due_on` text,
	`basis` text NOT NULL,
	`source_id` text NOT NULL,
	`raw_key` text,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `hardware_prints_key_idx` ON `hardware_prints` (`series`,`entity`,`period`,`window`,`source_id`);--> statement-breakpoint
CREATE INDEX `hardware_prints_seen_idx` ON `hardware_prints` (`first_seen_at`);--> statement-breakpoint
CREATE TABLE `print_documents` (
	`doc_id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`filed` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`raw_key` text,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `print_documents_source_idx` ON `print_documents` (`source_id`,`filed`);