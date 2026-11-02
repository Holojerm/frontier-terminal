CREATE TABLE `source_stats` (
	`source_id` text PRIMARY KEY NOT NULL,
	`snapshot_count` integer DEFAULT 0 NOT NULL,
	`first_fetched_at` text,
	`last_fetched_at` text,
	`run_count` integer DEFAULT 0 NOT NULL,
	`last_run_at` text
);
--> statement-breakpoint
DROP INDEX `alerts_created_at_idx`;--> statement-breakpoint
CREATE INDEX `alerts_created_id_idx` ON `alerts` (`created_at`,`id`);--> statement-breakpoint
DROP INDEX `changes_detected_at_idx`;--> statement-breakpoint
CREATE INDEX `changes_detected_id_idx` ON `changes` (`detected_at`,`id`);--> statement-breakpoint
DROP INDEX `source_runs_started_at_idx`;--> statement-breakpoint
CREATE INDEX `source_runs_started_id_idx` ON `source_runs` (`started_at`,`id`);--> statement-breakpoint
CREATE INDEX `source_runs_status_source_idx` ON `source_runs` (`status`,`source_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `snapshots_fetched_id_idx` ON `snapshots` (`fetched_at`,`id`);--> statement-breakpoint
-- Backfill. Both statements set absolute values, so re-running them after the
-- deploy reconciles any snapshot or run the previous build wrote in between.
-- WHERE true: SQLite needs it to parse ON CONFLICT after INSERT … SELECT.
INSERT INTO `source_stats` (`source_id`, `snapshot_count`, `first_fetched_at`, `last_fetched_at`)
SELECT `source_id`, count(*), min(`fetched_at`), max(`fetched_at`) FROM `snapshots` WHERE true GROUP BY `source_id`
ON CONFLICT (`source_id`) DO UPDATE SET `snapshot_count` = excluded.`snapshot_count`, `first_fetched_at` = excluded.`first_fetched_at`, `last_fetched_at` = excluded.`last_fetched_at`;--> statement-breakpoint
INSERT INTO `source_stats` (`source_id`, `run_count`, `last_run_at`)
SELECT `source_id`, count(*), max(`started_at`) FROM `source_runs` WHERE true GROUP BY `source_id`
ON CONFLICT (`source_id`) DO UPDATE SET `run_count` = excluded.`run_count`, `last_run_at` = excluded.`last_run_at`;
