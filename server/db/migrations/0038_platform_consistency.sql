ALTER TABLE `source_runs` ADD `parse_basis` text;--> statement-breakpoint
ALTER TABLE `alerts` ADD `recorded_at` text;--> statement-breakpoint
-- Rows written before the column: their write time is unknown, and created_at
-- is the closest the store holds.
UPDATE `alerts` SET `recorded_at` = `created_at` WHERE `recorded_at` IS NULL;--> statement-breakpoint
-- A GKG file is matched only against the alerts that exist when it is read,
-- so a press search began at the first file in its window recorded 15
-- minutes or more after its alert was written (track-record/search.ts ›
-- pressSearchedFrom). Searches already written say so through window_start;
-- the end of the window when no file qualified. Search-API rows (another
-- source_url) searched their whole window at once and are left alone.
UPDATE `track_record_searches` SET `window_start` = coalesce((
  SELECT substr(f.`stamp`, 1, 4) || '-' || substr(f.`stamp`, 5, 2) || '-' || substr(f.`stamp`, 7, 2) || 'T' ||
    substr(f.`stamp`, 9, 2) || ':' || substr(f.`stamp`, 11, 2) || ':' || substr(f.`stamp`, 13, 2) || '.000Z'
  FROM `gdelt_files` f JOIN `alerts` a ON a.`id` = `track_record_searches`.`alert_id`
  WHERE f.`stamp` > strftime('%Y%m%d%H%M%S', `track_record_searches`.`window_start`, '-15 minutes')
    AND f.`stamp` <= strftime('%Y%m%d%H%M%S', `track_record_searches`.`window_end`)
    AND julianday(f.`recorded_at`) >= julianday(a.`recorded_at`, '+15 minutes')
  ORDER BY f.`stamp` LIMIT 1
), `window_end`)
WHERE `source` = 'gdelt' AND `status` = 'ok' AND `source_url` = 'http://data.gdeltproject.org/gdeltv2/';--> statement-breakpoint
-- SQLite cannot add a column with a clock default, so a trigger stamps the
-- write time. Every alert writer gets it without setting the column; a writer
-- that does set it keeps its value.
CREATE TRIGGER `alerts_recorded_at` AFTER INSERT ON `alerts`
WHEN NEW.`recorded_at` IS NULL
BEGIN
  UPDATE `alerts` SET `recorded_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
CREATE INDEX `track_record_searches_searched_idx` ON `track_record_searches` (`searched_at`);