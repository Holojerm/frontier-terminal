-- destructive-ok: rebuilds probe_days to add placement to its primary key; every row is copied into the new table, as placement 'unpinned', before the old one is dropped.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_probe_days` (
	`lab` text NOT NULL,
	`day` text NOT NULL,
	`placement` text DEFAULT 'unpinned' NOT NULL,
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
	PRIMARY KEY(`lab`, `day`, `placement`)
);
--> statement-breakpoint
INSERT INTO `__new_probe_days`("lab", "day", "placement", "model", "route", "probes", "ok", "rate_limited", "failed", "excluded", "peak_n", "offpeak_n", "peak_tps", "offpeak_tps", "peak_ttft_ms", "offpeak_ttft_ms", "tps", "ttft_ms", "rolled_at", "source_url", "fetched_at") SELECT "lab", "day", 'unpinned', "model", "route", "probes", "ok", "rate_limited", "failed", "excluded", "peak_n", "offpeak_n", "peak_tps", "offpeak_tps", "peak_ttft_ms", "offpeak_ttft_ms", "tps", "ttft_ms", "rolled_at", "source_url", "fetched_at" FROM `probe_days`;--> statement-breakpoint
DROP TABLE `probe_days`;--> statement-breakpoint
ALTER TABLE `__new_probe_days` RENAME TO `probe_days`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `probe_days_day_idx` ON `probe_days` (`day`);--> statement-breakpoint
ALTER TABLE `latency_probes` ADD `placement` text DEFAULT 'unpinned' NOT NULL;--> statement-breakpoint
ALTER TABLE `latency_probes` ADD `served_by_pinned` integer;--> statement-breakpoint
ALTER TABLE `latency_probes` ADD `rate_limit_headers` text;