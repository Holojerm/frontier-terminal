-- Correct the 2026-11-18 judge alert headed "Google's docs no longer position
-- gemini-4-hydrogen as its balanced-class pick". Google's models page
-- (aistudio.google.com/docs/models.md, fetched 2026-11-18T21:00:59Z) had cut
-- the last clause of gemini-4-hydrogen's card, "featuring a shared 1M context
-- window and long decodes up to 1M tokens." The drift check reported the quoted
-- sentence gone, which it was, and the alert read that as Google dropping the
-- model. The rest of the sentence was still on the card: the judge re-quoted it
-- for the same model, and the 21:25 check found it present. gemini-4-hydrogen
-- never left the balanced cell.
--
-- The judge prompt now says a missing sentence is a missing sentence, and the
-- Worker stores an alert on a sentence the same run re-quotes for the same
-- model as `info` (layers/terminal/server/pipeline/judge/severity-gates.ts).
-- This fixes the one alert written before that. The new text stays inside the
-- alert's own cited change row
-- (layers/terminal/test/pipeline/reworded-sentence-correction.test.ts).
--
-- Rewritten in place, so the id, the cited change and the provenance stay as
-- stored. The severity drops to `info`, what the gate stores for a rewording.
-- Matched on the old headline as well as the id, so a database without this
-- alert is untouched and a second run is a no-op.
UPDATE `alerts` SET
  `severity` = 'info',
  `headline` = 'Google shortens the sentence the price matrix quotes for gemini-4-hydrogen',
  `explanation` = 'Google''s models page cut the last clause, "featuring a shared 1M context window and long decodes up to 1M tokens.", from its description of gemini-4-hydrogen. The rest of the sentence is still on the page, and gemini-4-hydrogen is still the model we show as Google''s balanced class.'
WHERE `id` = 'bb20bf396af0e32e6835fcc0379e5741250288abc8add35343fd4abbcff9cc8e'
  AND `headline` = 'Google''s docs no longer position gemini-4-hydrogen as its balanced-class pick';
