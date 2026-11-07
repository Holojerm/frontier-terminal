-- The contract half of 0040: #263 stopped reading and writing both tables and is
-- live, so no deployed code touches them (.claude/docs/gotchas.md, expand-only).
DROP TABLE IF EXISTS `gkg_backfills`;--> statement-breakpoint
DROP TABLE IF EXISTS `webhook_alert_log`;
