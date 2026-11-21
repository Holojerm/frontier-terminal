CREATE TABLE `gdelt_archive_files` (
	`stamp` text PRIMARY KEY NOT NULL,
	`pass` text NOT NULL,
	`status` text NOT NULL,
	`rows` integer NOT NULL,
	`figures` integer NOT NULL,
	`fetched_at` text NOT NULL,
	`recorded_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `gdelt_archive_files_pass_idx` ON `gdelt_archive_files` (`pass`,`stamp`);