CREATE TABLE `judge_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` text NOT NULL,
	`judged_through` text,
	`changes_seen` integer NOT NULL,
	`accepted` integer NOT NULL,
	`rejected` integer NOT NULL,
	`rejection_reason` text,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `judge_runs_started_at_idx` ON `judge_runs` (`started_at`);--> statement-breakpoint
CREATE INDEX `judge_runs_judged_through_idx` ON `judge_runs` (`judged_through`);