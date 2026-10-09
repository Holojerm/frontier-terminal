CREATE TABLE `recipe_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`recipe_id` text NOT NULL,
	`company` text NOT NULL,
	`key` text NOT NULL,
	`date` text NOT NULL,
	`value` real,
	`payload` text NOT NULL,
	`raw_key` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recipe_observations_recipe_idx` ON `recipe_observations` (`recipe_id`,`key`,`date`);--> statement-breakpoint
CREATE TABLE `recipe_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`recipe_id` text NOT NULL,
	`started_at` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`content_hash` text,
	`observations` integer NOT NULL,
	`source_url` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recipe_runs_recipe_idx` ON `recipe_runs` (`recipe_id`,`started_at`);