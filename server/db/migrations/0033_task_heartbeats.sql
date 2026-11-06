CREATE TABLE `task_heartbeats` (
	`task` text PRIMARY KEY NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_started_at` text NOT NULL,
	`last_completed_at` text,
	`last_failed_at` text,
	`last_error` text
);
