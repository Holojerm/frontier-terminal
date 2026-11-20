CREATE TABLE `supplier_documents` (
	`accession_no` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`form` text NOT NULL,
	`filed` text NOT NULL,
	`report_date` text,
	`status` text NOT NULL,
	`detail` text,
	`raw_key` text,
	`excerpts` integer NOT NULL,
	`judged_at` text,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `supplier_documents_ticker_idx` ON `supplier_documents` (`ticker`,`filed`);--> statement-breakpoint
CREATE TABLE `supplier_passages` (
	`id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`company_name` text NOT NULL,
	`layer` text NOT NULL,
	`relation` text NOT NULL,
	`counterparty` text NOT NULL,
	`counterparty_ticker` text,
	`counterparty_lab` text,
	`figures` text NOT NULL,
	`form` text NOT NULL,
	`filed` text NOT NULL,
	`period` text,
	`source_title` text NOT NULL,
	`quote` text NOT NULL,
	`alias_term` text,
	`alias_quote` text,
	`basis` text NOT NULL,
	`accession_no` text,
	`first_seen_at` text NOT NULL,
	`ended_at` text,
	`ended_by` text,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `supplier_passages_ticker_idx` ON `supplier_passages` (`ticker`,`ended_at`);