CREATE TABLE `reported_articles` (
	`id` text PRIMARY KEY NOT NULL,
	`title_key` text NOT NULL,
	`title` text NOT NULL,
	`outlet` text NOT NULL,
	`url` text NOT NULL,
	`published_at` text NOT NULL,
	`found_at` text NOT NULL,
	`raw_key` text,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `reported_articles_key_idx` ON `reported_articles` (`title_key`,`published_at`);--> statement-breakpoint
CREATE INDEX `reported_articles_found_idx` ON `reported_articles` (`found_at`,`id`);--> statement-breakpoint
CREATE TABLE `reported_figures` (
	`id` text PRIMARY KEY NOT NULL,
	`title_key` text NOT NULL,
	`article_id` text NOT NULL,
	`lab` text NOT NULL,
	`metric` text NOT NULL,
	`basis` text NOT NULL,
	`currency` text NOT NULL,
	`amount` real NOT NULL,
	`amount_text` text NOT NULL,
	`period` text,
	`published_at` text NOT NULL,
	`judged_at` text NOT NULL,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `reported_figures_lab_idx` ON `reported_figures` (`lab`,`metric`,`published_at`);--> statement-breakpoint
CREATE INDEX `reported_figures_judged_idx` ON `reported_figures` (`judged_at`,`id`);--> statement-breakpoint
CREATE TABLE `reported_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`title_key` text NOT NULL,
	`figures` integer NOT NULL,
	`judged_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `reported_reviews_judged_idx` ON `reported_reviews` (`judged_at`,`id`);--> statement-breakpoint
ALTER TABLE `gdelt_files` ADD `figures_at` text;--> statement-breakpoint
CREATE INDEX `gdelt_files_figures_idx` ON `gdelt_files` (`figures_at`,`stamp`);