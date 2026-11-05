CREATE TABLE `rollup_state` (
	`name` text PRIMARY KEY NOT NULL,
	`rolled_through` text NOT NULL,
	`started` text NOT NULL,
	`updated_at` text NOT NULL
);
