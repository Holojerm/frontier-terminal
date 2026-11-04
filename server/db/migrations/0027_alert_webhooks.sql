CREATE TABLE `webhook_alert_log` (
	`alert_id` text PRIMARY KEY NOT NULL,
	`seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `webhook_alert_log_seen_idx` ON `webhook_alert_log` (`seen_at`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`alert_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`seen_at` text NOT NULL,
	`not_before` text NOT NULL,
	`next_attempt_at` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` text,
	`last_status` integer,
	`last_error` text,
	`delivered_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_deliveries_alert_webhook_idx` ON `webhook_deliveries` (`alert_id`,`webhook_id`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_status_next_idx` ON `webhook_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_webhook_idx` ON `webhook_deliveries` (`webhook_id`,`status`);--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`api_key_id` text NOT NULL,
	`url` text NOT NULL,
	`min_severity` text NOT NULL,
	`secret_hash` text NOT NULL,
	`signing_key_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`failing_since` text,
	`last_error` text,
	`removed_at` text
);
--> statement-breakpoint
CREATE INDEX `webhooks_api_key_idx` ON `webhooks` (`api_key_id`);