CREATE TABLE `filed_fact_reads` (
	`id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`kind` text NOT NULL,
	`accession_no` text,
	`status` text NOT NULL,
	`detail` text,
	`content_hash` text,
	`facts` integer NOT NULL,
	`started_at` text NOT NULL,
	`source_url` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `filed_fact_reads_doc_idx` ON `filed_fact_reads` (`ticker`,`kind`,`started_at`);--> statement-breakpoint
CREATE TABLE `filed_facts` (
	`id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`cik` text NOT NULL,
	`concept` text NOT NULL,
	`dims` text NOT NULL,
	`start` text,
	`end` text NOT NULL,
	`value` real NOT NULL,
	`unit` text NOT NULL,
	`form` text NOT NULL,
	`filed` text NOT NULL,
	`accession_no` text NOT NULL,
	`basis` text NOT NULL,
	`raw_key` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `filed_facts_series_idx` ON `filed_facts` (`ticker`,`concept`,`end`);--> statement-breakpoint
CREATE INDEX `filed_facts_filed_idx` ON `filed_facts` (`filed`,`id`);