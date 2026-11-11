-- Correct the 2026-11-10 judge decision that rests Google's flagship cell on
-- Argon's card. Google's models page (aistudio.google.com/docs/models.md,
-- fetched 2026-11-11T02:25:02Z) prints two Gemini 4 cards. Argon's reads "Our
-- efficient Gemini 4 frontier reasoning model, delivering faster responses and
-- lower token spend per turn compared to Gemini 4 Carbon…". It names Carbon
-- only to compare Argon with it, but the naming rule passed it, and the matrix
-- showed Carbon as the flagship on the strength of Argon's description. The
-- gate now rejects another model's card sentence
-- (layers/terminal/server/pipeline/judge/page-cards.ts, cardOwners); this fixes
-- the one decision written before that.
--
-- A new, newer decision, not an edit: class_map_decisions is history, and a
-- point-in-time /api/prices for 2026-11-10 should still show what the matrix
-- showed then. The model stays gemini-4-carbon, now resting on Carbon's own
-- card, copied character for character from that fetch. It passes the gate
-- (layers/terminal/test/pipeline/google-flagship-correction.test.ts).
-- Inserted only where the judge's decision is stored and this one is not, so
-- a database without it is untouched and a second run is a no-op.
INSERT INTO `class_map_decisions`
  (`id`, `provider`, `class`, `model_slug`, `basis`, `basis_source_id`, `decided_at`, `decided_by`, `source_url`, `fetched_at`)
SELECT
  'owner-2026-11-11-google-flagship',
  'google',
  'flagship',
  'gemini-4-carbon',
  'Our strongest reasoning model, built for complex software engineering, multimodal knowledge work, scientific reasoning, and cybersecurity defense.',
  'google-models-md',
  '2026-11-11T02:25:02.000Z',
  'owner',
  'https://aistudio.google.com/docs/models.md',
  '2026-11-11T02:25:02.000Z'
WHERE EXISTS (
    SELECT 1 FROM `class_map_decisions`
    WHERE `provider` = 'google' AND `class` = 'flagship'
      AND `basis` = 'Our efficient Gemini 4 frontier reasoning model, delivering faster responses and lower token spend per turn compared to Gemini 4 Carbon across complex coding, agentic, math, and science tasks.'
  )
  AND NOT EXISTS (
    SELECT 1 FROM `class_map_decisions` WHERE `id` = 'owner-2026-11-11-google-flagship'
  );
