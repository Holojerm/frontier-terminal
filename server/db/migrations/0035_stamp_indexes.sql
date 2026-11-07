CREATE INDEX `claim_readings_computed_idx` ON `claim_readings` (`computed_at`);--> statement-breakpoint
CREATE INDEX `claim_verdicts_judged_idx` ON `claim_verdicts` (`judged_at`);--> statement-breakpoint
CREATE INDEX `deploy_checks_fetched_idx` ON `deploy_checks` (`fetched_at`);--> statement-breakpoint
CREATE INDEX `filed_fact_reads_started_idx` ON `filed_fact_reads` (`started_at`);--> statement-breakpoint
CREATE INDEX `filing_detections_recorded_idx` ON `filing_detections` (`recorded_at`);--> statement-breakpoint
CREATE INDEX `gdelt_files_recorded_idx` ON `gdelt_files` (`recorded_at`);