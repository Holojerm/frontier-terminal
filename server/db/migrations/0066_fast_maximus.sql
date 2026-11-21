CREATE TABLE `market_bars` (
	`symbol` text NOT NULL,
	`date` text NOT NULL,
	`close` real NOT NULL,
	`volume` integer NOT NULL,
	`dataset` text NOT NULL,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`symbol`, `date`)
);
--> statement-breakpoint
CREATE TABLE `market_fetches` (
	`symbol` text NOT NULL,
	`dataset` text NOT NULL,
	`start` text NOT NULL,
	`through` text NOT NULL,
	`rows` integer NOT NULL,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`symbol`, `dataset`)
);
--> statement-breakpoint
CREATE TABLE `signal_results` (
	`series_id` text NOT NULL,
	`ticker` text NOT NULL,
	`test` text NOT NULL,
	`horizon` integer NOT NULL,
	`sample` text NOT NULL,
	`status` text NOT NULL,
	`n` integer NOT NULL,
	`estimate` real,
	`t_stat` real,
	`p_value` real,
	`from_date` text,
	`to_date` text,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`series_id`, `ticker`, `test`, `horizon`, `sample`)
);
--> statement-breakpoint
CREATE TABLE `signal_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text NOT NULL,
	`series` integer NOT NULL,
	`tests` integer NOT NULL,
	`prices_through` text,
	`detail` text,
	`coverage` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `signal_runs_started_idx` ON `signal_runs` (`started_at`);