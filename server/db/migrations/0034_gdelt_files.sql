CREATE TABLE `gdelt_files` (
	`stamp` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`status` text NOT NULL,
	`rows` integer NOT NULL,
	`matched` integer NOT NULL,
	`raw_key` text,
	`fetched_at` text NOT NULL,
	`recorded_at` text NOT NULL
);
