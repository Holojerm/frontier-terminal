CREATE TABLE `subscribers` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`status` text NOT NULL,
	`confirm_token_hash` text,
	`confirm_sent_at` text,
	`subscribed_from` text,
	`created_at` text NOT NULL,
	`confirmed_at` text,
	`unsubscribed_at` text,
	`last_digest_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscribers_email_idx` ON `subscribers` (`email`);--> statement-breakpoint
CREATE INDEX `subscribers_confirm_token_idx` ON `subscribers` (`confirm_token_hash`);--> statement-breakpoint
CREATE INDEX `subscribers_status_idx` ON `subscribers` (`status`);