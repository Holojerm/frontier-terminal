CREATE TABLE `bulk_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`api_key_id` text NOT NULL,
	`token_id` text NOT NULL,
	`bucket` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`revoke_reason` text
);
--> statement-breakpoint
CREATE INDEX `bulk_grants_api_key_idx` ON `bulk_grants` (`api_key_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `bulk_grants_token_idx` ON `bulk_grants` (`token_id`);