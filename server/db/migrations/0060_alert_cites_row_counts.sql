CREATE TABLE `alert_cites` (
	`alert_id` text NOT NULL,
	`provider` text NOT NULL,
	`entity_type` text NOT NULL,
	PRIMARY KEY(`alert_id`, `provider`, `entity_type`)
);
--> statement-breakpoint
CREATE INDEX `alert_cites_provider_idx` ON `alert_cites` (`provider`,`entity_type`,`alert_id`);--> statement-breakpoint
CREATE INDEX `alert_cites_type_idx` ON `alert_cites` (`entity_type`,`alert_id`);--> statement-breakpoint
CREATE TABLE `row_counts` (
	`table_name` text NOT NULL,
	`key` text NOT NULL,
	`n` integer NOT NULL,
	PRIMARY KEY(`table_name`, `key`)
);
--> statement-breakpoint
-- Everything below is written by hand: drizzle-kit does not manage triggers.
-- Each trigger is created before its backfill, and the backfill overwrites, so
-- a row written between the two is counted once.
CREATE TRIGGER `alerts_cites` AFTER INSERT ON `alerts`
WHEN json_valid(NEW.`change_ids`)
BEGIN
  INSERT OR IGNORE INTO `alert_cites` (`alert_id`, `provider`, `entity_type`)
  SELECT NEW.`id`, c.`provider`, c.`entity_type`
  FROM json_each(NEW.`change_ids`) j JOIN `changes` c ON c.`id` = j.value;
END;
--> statement-breakpoint
INSERT OR IGNORE INTO `alert_cites` (`alert_id`, `provider`, `entity_type`)
SELECT a.`id`, c.`provider`, c.`entity_type`
FROM `alerts` a, json_each(a.`change_ids`) j JOIN `changes` c ON c.`id` = j.value;
--> statement-breakpoint
CREATE TRIGGER `entities_count_insert` AFTER INSERT ON `entities`
BEGIN
  INSERT INTO `row_counts` (`table_name`, `key`, `n`) VALUES ('entities', NEW.`source_id`, 1)
  ON CONFLICT (`table_name`, `key`) DO UPDATE SET `n` = `n` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `entities_count_delete` AFTER DELETE ON `entities`
BEGIN
  UPDATE `row_counts` SET `n` = `n` - 1 WHERE `table_name` = 'entities' AND `key` = OLD.`source_id`;
END;
--> statement-breakpoint
INSERT INTO `row_counts` (`table_name`, `key`, `n`)
SELECT 'entities', `source_id`, count(*) FROM `entities` WHERE true GROUP BY `source_id`
ON CONFLICT (`table_name`, `key`) DO UPDATE SET `n` = excluded.`n`;
--> statement-breakpoint
CREATE TRIGGER `changes_count_insert` AFTER INSERT ON `changes`
BEGIN
  INSERT INTO `row_counts` (`table_name`, `key`, `n`) VALUES ('changes', NEW.`entity_type`, 1)
  ON CONFLICT (`table_name`, `key`) DO UPDATE SET `n` = `n` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `changes_count_delete` AFTER DELETE ON `changes`
BEGIN
  UPDATE `row_counts` SET `n` = `n` - 1 WHERE `table_name` = 'changes' AND `key` = OLD.`entity_type`;
END;
--> statement-breakpoint
INSERT INTO `row_counts` (`table_name`, `key`, `n`)
SELECT 'changes', `entity_type`, count(*) FROM `changes` WHERE true GROUP BY `entity_type`
ON CONFLICT (`table_name`, `key`) DO UPDATE SET `n` = excluded.`n`;
--> statement-breakpoint
CREATE TRIGGER `alerts_count_insert` AFTER INSERT ON `alerts`
BEGIN
  INSERT INTO `row_counts` (`table_name`, `key`, `n`) VALUES ('alerts', '', 1)
  ON CONFLICT (`table_name`, `key`) DO UPDATE SET `n` = `n` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `alerts_count_delete` AFTER DELETE ON `alerts`
BEGIN
  UPDATE `row_counts` SET `n` = `n` - 1 WHERE `table_name` = 'alerts' AND `key` = '';
END;
--> statement-breakpoint
INSERT INTO `row_counts` (`table_name`, `key`, `n`)
SELECT 'alerts', '', count(*) FROM `alerts` WHERE true
ON CONFLICT (`table_name`, `key`) DO UPDATE SET `n` = excluded.`n`;
--> statement-breakpoint
CREATE TRIGGER `recipe_observations_count_insert` AFTER INSERT ON `recipe_observations`
BEGIN
  INSERT INTO `row_counts` (`table_name`, `key`, `n`) VALUES ('recipe_observations', NEW.`recipe_id`, 1)
  ON CONFLICT (`table_name`, `key`) DO UPDATE SET `n` = `n` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `recipe_observations_count_delete` AFTER DELETE ON `recipe_observations`
BEGIN
  UPDATE `row_counts` SET `n` = `n` - 1 WHERE `table_name` = 'recipe_observations' AND `key` = OLD.`recipe_id`;
END;
--> statement-breakpoint
INSERT INTO `row_counts` (`table_name`, `key`, `n`)
SELECT 'recipe_observations', `recipe_id`, count(*) FROM `recipe_observations` WHERE true GROUP BY `recipe_id`
ON CONFLICT (`table_name`, `key`) DO UPDATE SET `n` = excluded.`n`;
