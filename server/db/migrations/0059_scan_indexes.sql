CREATE INDEX `changes_type_detected_idx` ON `changes` (`entity_type`,`detected_at`);--> statement-breakpoint
-- Written by hand: drizzle-kit quotes an expression as if it were column names.
CREATE INDEX `entities_type_date_idx` ON `entities` (`entity_type`, json_extract(`payload`, '$.date'));--> statement-breakpoint
CREATE INDEX `source_runs_read_idx` ON `source_runs` (`source_id`,`started_at`,`snapshot_id`) WHERE status in ('ok', 'unchanged', 'baseline');--> statement-breakpoint
CREATE INDEX `recipe_runs_started_idx` ON `recipe_runs` (`started_at`);