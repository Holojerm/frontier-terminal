CREATE TABLE `class_map_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`class` text NOT NULL,
	`model_slug` text NOT NULL,
	`basis` text NOT NULL,
	`basis_source_id` text NOT NULL,
	`decided_at` text NOT NULL,
	`decided_by` text NOT NULL,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `class_map_decisions_cell_idx` ON `class_map_decisions` (`provider`,`class`,`decided_at`);