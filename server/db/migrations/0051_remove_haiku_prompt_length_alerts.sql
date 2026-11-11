-- Remove the two 2026-10-07 launch alerts that announced Anthropic's
-- prompt-length price bands as models:
--   "Anthropic lists a new model, claude-haiku-5-5-(for-prompts-over-100,000-tokens) — …"
--   "Anthropic lists a new model, claude-haiku-5-5-(for-prompts-up-to-100,000-tokens) — …"
-- The pricing parser read the row labels "Claude Haiku 5.5 (for prompts over /
-- up to 100,000 tokens)" as two model names, and the model-floor rule
-- announced each as a launch. There is no such model: the real launch is the
-- claude-haiku-5-5 alert of 2026-10-09, and the prompt-length pricing is
-- covered by its own judge alert, which stays. The rule has since refused a
-- name that is not a vendor slug (model-floor.ts › WELL_FORMED_SLUG), and the
-- price rows are long marked removed.
--
-- Deleted, not rewritten: no correct text exists for an event that did not
-- happen. Their track-record rows go first, because those rows exist only to
-- score these alerts. The change rows they cite stay: the change log records
-- what the parser read, and is never rewritten. Webhook deliveries stay too,
-- as the record of what was sent. Each statement is matched on id and the
-- alert's exact headline, so a database without these alerts is untouched and a
-- second run is a no-op.
DELETE FROM `track_record_verdicts` WHERE `alert_id` IN (
  SELECT `id` FROM `alerts`
  WHERE `id` IN (
    '3f4cefa36c7b4d957f541e6039ca2cda1300fd1c0d0efbc5d686a3c1a86e053c',
    'f65c31029a020f166cdecc02bfbbe63431f2039a2a34fffe31c02562ecb75062'
  )
  AND `headline` IN (
    'Anthropic lists a new model, claude-haiku-5-5-(for-prompts-over-100,000-tokens) — $0.50 in / $2.50 out per MTok',
    'Anthropic lists a new model, claude-haiku-5-5-(for-prompts-up-to-100,000-tokens) — $0.10 in / $0.50 out per MTok'
  )
);
--> statement-breakpoint
DELETE FROM `track_record_candidates` WHERE `alert_id` IN (
  SELECT `id` FROM `alerts`
  WHERE `id` IN (
    '3f4cefa36c7b4d957f541e6039ca2cda1300fd1c0d0efbc5d686a3c1a86e053c',
    'f65c31029a020f166cdecc02bfbbe63431f2039a2a34fffe31c02562ecb75062'
  )
  AND `headline` IN (
    'Anthropic lists a new model, claude-haiku-5-5-(for-prompts-over-100,000-tokens) — $0.50 in / $2.50 out per MTok',
    'Anthropic lists a new model, claude-haiku-5-5-(for-prompts-up-to-100,000-tokens) — $0.10 in / $0.50 out per MTok'
  )
);
--> statement-breakpoint
DELETE FROM `track_record_searches` WHERE `alert_id` IN (
  SELECT `id` FROM `alerts`
  WHERE `id` IN (
    '3f4cefa36c7b4d957f541e6039ca2cda1300fd1c0d0efbc5d686a3c1a86e053c',
    'f65c31029a020f166cdecc02bfbbe63431f2039a2a34fffe31c02562ecb75062'
  )
  AND `headline` IN (
    'Anthropic lists a new model, claude-haiku-5-5-(for-prompts-over-100,000-tokens) — $0.50 in / $2.50 out per MTok',
    'Anthropic lists a new model, claude-haiku-5-5-(for-prompts-up-to-100,000-tokens) — $0.10 in / $0.50 out per MTok'
  )
);
--> statement-breakpoint
DELETE FROM `alerts`
WHERE `id` IN (
    '3f4cefa36c7b4d957f541e6039ca2cda1300fd1c0d0efbc5d686a3c1a86e053c',
    'f65c31029a020f166cdecc02bfbbe63431f2039a2a34fffe31c02562ecb75062'
  )
  AND `headline` IN (
    'Anthropic lists a new model, claude-haiku-5-5-(for-prompts-over-100,000-tokens) — $0.50 in / $2.50 out per MTok',
    'Anthropic lists a new model, claude-haiku-5-5-(for-prompts-up-to-100,000-tokens) — $0.10 in / $0.50 out per MTok'
  );
