CREATE TABLE `filed_guidance` (
	`id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`cik` text NOT NULL,
	`accession_no` text NOT NULL,
	`filed` text NOT NULL,
	`fiscal_year` integer NOT NULL,
	`low` real NOT NULL,
	`high` real NOT NULL,
	`sentence` text NOT NULL,
	`raw_key` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `filed_guidance_filer_idx` ON `filed_guidance` (`ticker`,`fiscal_year`,`filed`);--> statement-breakpoint
ALTER TABLE `reported_figures` ADD `counterparty` text;--> statement-breakpoint
ALTER TABLE `reported_reviews` ADD `deals_at` text;