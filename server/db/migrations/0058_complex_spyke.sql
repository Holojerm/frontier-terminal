CREATE TABLE `power_site_documents` (
	`document_id` text NOT NULL,
	`site` text NOT NULL,
	`accession_no` text NOT NULL,
	`cik` text NOT NULL,
	`filer` text NOT NULL,
	`form` text NOT NULL,
	`file_type` text NOT NULL,
	`filed` text NOT NULL,
	`terms` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`raw_key` text,
	`excerpts` integer NOT NULL,
	`judged_at` text,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`document_id`, `site`)
);
--> statement-breakpoint
CREATE INDEX `power_site_documents_site_idx` ON `power_site_documents` (`site`,`filed`);--> statement-breakpoint
CREATE TABLE `power_site_ties` (
	`id` text PRIMARY KEY NOT NULL,
	`site` text NOT NULL,
	`role` text NOT NULL,
	`company_name` text NOT NULL,
	`parent` text,
	`ticker` text,
	`unlisted` text,
	`mw` real,
	`mw_meaning` text,
	`source_title` text,
	`publisher` text,
	`published` text,
	`quote` text NOT NULL,
	`basis` text NOT NULL,
	`accession_no` text,
	`form` text,
	`filed` text,
	`first_seen_at` text NOT NULL,
	`ended_at` text,
	`ended_by` text,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `power_site_ties_site_idx` ON `power_site_ties` (`site`,`ended_at`);