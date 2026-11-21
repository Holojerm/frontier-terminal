CREATE TABLE `archived_gpu_prices` (
	`id` text PRIMARY KEY NOT NULL,
	`capture_id` text NOT NULL,
	`provider` text NOT NULL,
	`key` text NOT NULL,
	`gpu` text NOT NULL,
	`value` real NOT NULL,
	`payload` text NOT NULL,
	`captured_at` text NOT NULL,
	`original_url` text NOT NULL,
	`basis` text NOT NULL,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `archived_gpu_prices_provider_idx` ON `archived_gpu_prices` (`provider`,`gpu`,`captured_at`);--> statement-breakpoint
CREATE INDEX `archived_gpu_prices_captured_id_idx` ON `archived_gpu_prices` (`captured_at`,`id`);