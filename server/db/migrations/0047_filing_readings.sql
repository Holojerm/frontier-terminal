CREATE TABLE `filing_readings` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`accession_no` text NOT NULL,
	`part` text NOT NULL,
	`quote` text NOT NULL,
	`values` text NOT NULL,
	`alert_id` text,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL,
	`read_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `filing_readings_accession_idx` ON `filing_readings` (`accession_no`);