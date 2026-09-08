CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`severity` text NOT NULL,
	`headline` text NOT NULL,
	`explanation` text NOT NULL,
	`change_ids` text NOT NULL,
	`rule` text NOT NULL,
	`created_at` text NOT NULL,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `alerts_created_at_idx` ON `alerts` (`created_at`);--> statement-breakpoint
CREATE TABLE `changes` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_key` text NOT NULL,
	`entity_type` text NOT NULL,
	`provider` text NOT NULL,
	`change_type` text NOT NULL,
	`before_hash` text,
	`after_hash` text,
	`before_json` text,
	`after_json` text,
	`detected_at` text NOT NULL,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `changes_detected_at_idx` ON `changes` (`detected_at`);--> statement-breakpoint
CREATE INDEX `changes_entity_key_idx` ON `changes` (`entity_key`);--> statement-breakpoint
CREATE TABLE `entities` (
	`source_id` text NOT NULL,
	`entity_key` text NOT NULL,
	`entity_type` text NOT NULL,
	`provider` text NOT NULL,
	`content_hash` text NOT NULL,
	`payload` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`source_id`, `entity_key`)
);
--> statement-breakpoint
CREATE INDEX `entities_entity_key_idx` ON `entities` (`entity_key`);--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`raw_key` text NOT NULL,
	`http_status` integer,
	`bytes` integer,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `snapshots_source_fetched_idx` ON `snapshots` (`source_id`,`fetched_at`);--> statement-breakpoint
CREATE TABLE `source_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`source_id` text NOT NULL,
	`started_at` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`snapshot_id` text,
	`added` integer NOT NULL,
	`removed` integer NOT NULL,
	`modified` integer NOT NULL,
	`source_url` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `source_runs_source_started_idx` ON `source_runs` (`source_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `source_runs_started_at_idx` ON `source_runs` (`started_at`);