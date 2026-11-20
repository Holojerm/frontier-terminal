CREATE TABLE `latency_probes` (
	`id` text PRIMARY KEY NOT NULL,
	`lab` text NOT NULL,
	`model` text NOT NULL,
	`route` text NOT NULL,
	`provider` text NOT NULL,
	`served_by` text,
	`started_at` text NOT NULL,
	`outcome` text NOT NULL,
	`http_status` integer,
	`detail` text,
	`provider_code` text,
	`ttft_ms` integer,
	`total_ms` integer NOT NULL,
	`output_tokens` integer,
	`reasoning_tokens` integer,
	`tokens_per_second` real,
	`finish_reason` text,
	`cost_usd` real,
	`generation_id` text,
	`ran_from` text NOT NULL,
	`raw_key` text,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `latency_probes_started_idx` ON `latency_probes` (`started_at`);--> statement-breakpoint
CREATE INDEX `latency_probes_lab_started_idx` ON `latency_probes` (`lab`,`started_at`);--> statement-breakpoint
CREATE TABLE `probe_days` (
	`lab` text NOT NULL,
	`day` text NOT NULL,
	`model` text NOT NULL,
	`route` text NOT NULL,
	`probes` integer NOT NULL,
	`ok` integer NOT NULL,
	`rate_limited` integer NOT NULL,
	`failed` integer NOT NULL,
	`excluded` integer NOT NULL,
	`peak_n` integer NOT NULL,
	`offpeak_n` integer NOT NULL,
	`peak_tps` real,
	`offpeak_tps` real,
	`peak_ttft_ms` real,
	`offpeak_ttft_ms` real,
	`tps` real,
	`ttft_ms` real,
	`rolled_at` text NOT NULL,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`lab`, `day`)
);
--> statement-breakpoint
CREATE INDEX `probe_days_day_idx` ON `probe_days` (`day`);