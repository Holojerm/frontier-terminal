ALTER TABLE `claim_status_changes` ADD `source_url` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `claim_status_changes` ADD `fetched_at` text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE `claim_status_changes` SET `source_url` = 'https://frontierterm.com/theses/' || `thesis_id`, `fetched_at` = `changed_at`;
