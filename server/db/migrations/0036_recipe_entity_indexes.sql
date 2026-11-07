CREATE INDEX `entities_type_idx` ON `entities` (`entity_type`);--> statement-breakpoint
CREATE INDEX `recipe_observations_fetched_idx` ON `recipe_observations` (`recipe_id`,`fetched_at`);