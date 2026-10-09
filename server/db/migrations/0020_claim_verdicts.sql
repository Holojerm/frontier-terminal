CREATE TABLE `claim_verdicts` (
	`id` text PRIMARY KEY NOT NULL,
	`thesis_id` text NOT NULL,
	`claim_id` text NOT NULL,
	`subject` text NOT NULL,
	`change_id` text NOT NULL,
	`provider` text NOT NULL,
	`verdict` text NOT NULL,
	`rationale` text NOT NULL,
	`facts` text NOT NULL,
	`detected_at` text NOT NULL,
	`judged_at` text NOT NULL,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `claim_verdicts_claim_idx` ON `claim_verdicts` (`claim_id`,`detected_at`);