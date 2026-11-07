-- Expand-only (.claude/docs/gotchas.md): gkg_backfills and webhook_alert_log are no
-- longer read or written, but the deploy that drops them must come after this one is live.
ALTER TABLE `gdelt_files` ADD `vocabulary` text;--> statement-breakpoint
CREATE INDEX `alerts_recorded_idx` ON `alerts` (`recorded_at`);--> statement-breakpoint
CREATE INDEX `class_map_decisions_decided_idx` ON `class_map_decisions` (`decided_at`);
