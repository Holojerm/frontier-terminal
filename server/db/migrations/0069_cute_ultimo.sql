CREATE TABLE `call_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`call_date` text NOT NULL,
	`period_label` text NOT NULL,
	`fiscal_year` integer NOT NULL,
	`fiscal_quarter` integer NOT NULL,
	`kind` text NOT NULL,
	`url` text NOT NULL,
	`page_url` text,
	`produced_by` text,
	`accession_no` text,
	`status` text NOT NULL,
	`detail` text,
	`job_id` text,
	`audio_seconds` real,
	`cost_usd` real,
	`raw_key` text,
	`content_hash` text,
	`statements` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`first_seen_at` text NOT NULL,
	`submitted_at` text,
	`read_at` text,
	`judged_at` text,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `call_documents_status_idx` ON `call_documents` (`status`,`kind`);--> statement-breakpoint
CREATE INDEX `call_documents_ticker_idx` ON `call_documents` (`ticker`,`call_date`);--> statement-breakpoint
CREATE TABLE `guidance_resolutions` (
	`id` text PRIMARY KEY NOT NULL,
	`guidance_id` text NOT NULL,
	`ticker` text NOT NULL,
	`metric` text NOT NULL,
	`actual` real NOT NULL,
	`guided_mid` real NOT NULL,
	`error_share` real NOT NULL,
	`state` text NOT NULL,
	`concept` text NOT NULL,
	`form` text NOT NULL,
	`filed` text NOT NULL,
	`accession_no` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `guidance_resolutions_guidance_idx` ON `guidance_resolutions` (`guidance_id`);--> statement-breakpoint
CREATE INDEX `guidance_resolutions_ticker_idx` ON `guidance_resolutions` (`ticker`,`filed`);--> statement-breakpoint
ALTER TABLE `filed_guidance` ADD `source` text DEFAULT 'release' NOT NULL;--> statement-breakpoint
ALTER TABLE `filed_guidance` ADD `metric` text DEFAULT 'capex' NOT NULL;--> statement-breakpoint
ALTER TABLE `filed_guidance` ADD `segment` text;--> statement-breakpoint
ALTER TABLE `filed_guidance` ADD `basis` text;--> statement-breakpoint
ALTER TABLE `filed_guidance` ADD `unit` text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE `filed_guidance` ADD `bound` text DEFAULT 'range' NOT NULL;--> statement-breakpoint
ALTER TABLE `filed_guidance` ADD `fiscal_quarter` integer;--> statement-breakpoint
ALTER TABLE `filed_guidance` ADD `period_start` text;--> statement-breakpoint
ALTER TABLE `filed_guidance` ADD `period_end` text;--> statement-breakpoint
ALTER TABLE `filed_guidance` ADD `speaker` text;--> statement-breakpoint
ALTER TABLE `filed_guidance` ADD `at_ms` integer;--> statement-breakpoint
ALTER TABLE `filed_guidance` ADD `page` integer;--> statement-breakpoint
ALTER TABLE `filed_guidance` ADD `call_document_id` text;--> statement-breakpoint
ALTER TABLE `filed_guidance` ADD `page_url` text;--> statement-breakpoint
ALTER TABLE `filed_guidance` ADD `method` text DEFAULT 'parser' NOT NULL;--> statement-breakpoint
CREATE INDEX `filed_guidance_source_idx` ON `filed_guidance` (`source`,`ticker`,`filed`);