CREATE TABLE `ops_alert_state` (
	`key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`detail` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`reported_at` text
);
