-- A removal was stamped with the removed row's fetched_at, which only moves
-- when the row's content changes, so it was usually the first sighting. It is
-- now the poll that found the row gone: detected_at, the after snapshot's fetch.
UPDATE `changes` SET `fetched_at` = `detected_at`
WHERE `change_type` = 'removed' AND `fetched_at` <> `detected_at`;--> statement-breakpoint
-- Judge alerts take created_at and provenance from the newest-fetched cited
-- change, ties to the smallest id (judge/contract.ts). Recomputed only where a
-- removal is cited, so no other alert moves.
UPDATE `alerts` SET (`created_at`, `source_url`, `fetched_at`) = (
  SELECT c.`fetched_at`, c.`source_url`, c.`fetched_at`
  FROM json_each(`alerts`.`change_ids`) j JOIN `changes` c ON c.`id` = j.`value`
  ORDER BY c.`fetched_at` DESC, c.`id` ASC LIMIT 1
)
WHERE `rule` = 'agent-judge' AND EXISTS (
  SELECT 1 FROM json_each(`alerts`.`change_ids`) j JOIN `changes` c ON c.`id` = j.`value`
  WHERE c.`change_type` = 'removed'
);--> statement-breakpoint
-- Hiring roll-ups keep created_at (already detected_at); their provenance is
-- the newest-detected cited change, ties to the smallest id (hiring-rollup.ts).
UPDATE `alerts` SET (`source_url`, `fetched_at`) = (
  SELECT c.`source_url`, c.`fetched_at`
  FROM json_each(`alerts`.`change_ids`) j JOIN `changes` c ON c.`id` = j.`value`
  ORDER BY c.`detected_at` DESC, c.`id` ASC LIMIT 1
)
WHERE `rule` = 'hiring-rollup' AND EXISTS (
  SELECT 1 FROM json_each(`alerts`.`change_ids`) j JOIN `changes` c ON c.`id` = j.`value`
  WHERE c.`change_type` = 'removed'
);
