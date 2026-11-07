-- destructive-ok: only the ops:alert drain reads notified_at, and this change removes it (alerts move to the fleet dashboard); an old Worker's drain run during the deploy window fails and nothing depends on it.
DROP INDEX `ops_events_notified_at_idx`;--> statement-breakpoint
ALTER TABLE `ops_events` DROP COLUMN `notified_at`;