-- Correct the 2026-11-09 judge alert that called claude-fable-5-1 delisted.
-- The removal it cited came from Anthropic's models overview alone, which
-- trimmed its table at the claude-fable-5-2 launch; the pricing page still
-- lists claude-fable-5-1. The judge now gets that fact and the Worker rejects
-- the wording (layers/terminal/server/pipeline/judge/still-listed.ts); this
-- fixes the one alert written before that.
--
-- Rewritten in place, so the id, the cited changes, the severity (the launch
-- carries notable) and the provenance stay as stored: /alerts/<id>, the
-- webhook deliveries and the track-record rows keyed on it keep working. Every
-- number and slug is in the cited change rows. Matched on the old headline as
-- well as the id, so a database without that alert is untouched.
UPDATE `alerts` SET
  `headline` = 'Anthropic launches claude-fable-5-2 and claude-mythos-5-2; its models overview drops claude-fable-5-1',
  `explanation` = 'Anthropic''s pricing page added claude-fable-5-2 (input 8, output 40 per MTok, plus a batch tier at input 4, output 20 per MTok) and claude-mythos-5-2, limited availability (input 8, output 40 per MTok, plus a batch tier at input 4, output 20 per MTok). Its models overview now shows claude-fable-5-2 where claude-fable-5-1 was. The pricing page still lists claude-fable-5-1 at input 10, output 50 per MTok. An earlier version of this alert read the overview change as Anthropic withdrawing the model.'
WHERE `id` = '645cb39b89c3a4c721ea09cb5a147bf31c3d80816d7efe60511c2644f5c3d3d8'
  AND `headline` = 'Anthropic delists claude-fable-5-1, launches claude-fable-5-2 and claude-mythos-5-2';
