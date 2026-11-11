-- Correct the five Google launch alerts that announced a model at its batch
-- price. The model-floor rule (layers/terminal/server/pipeline/model-floor.ts)
-- priced the headline off the untiered row, or else the first row parsed.
-- Google's parser names its list tier 'standard', so no row was untiered and
-- the first row was batch: gemini-4-carbon read "$1.00 in / $5.00 out per
-- MTok" while its list price, and the price matrix beside it, was $2.00 /
-- $10.00. The rule now takes the standard-tier price in effect, as the matrix
-- does, and names a scheduled standard price in the explanation; this fixes
-- the five alerts written before that.
--
-- Each new headline and explanation is what the fixed rule writes from the
-- alert's own cited change rows, copied from production's /export/changes.json
-- into fixtures/alerts/google-launch-alerts.json
-- (layers/terminal/test/pipeline/launch-price-correction.test.ts holds them
-- equal). Rewritten in place, so the id, the cited changes, the severity and
-- the provenance stay as stored. Matched on the old headline as well as the
-- id, so a database without these alerts is untouched and a second run is a
-- no-op.
-- 2026-11-10 gemini-4-carbon
UPDATE `alerts` SET
  `headline` = 'Google lists a new model, gemini-4-carbon — $2.00 in / $10.00 out per MTok',
  `explanation` = 'gemini-4-carbon appears for the first time in Google''s catalog (https://aistudio.google.com/docs/pricing.md), listed as batch, contributor, flex, priority, standard. Its standard price moves to $4.00 in / $20.00 out per MTok on 2026-12-01. A model no catalog has listed before always alerts — the model-floor rule, no model in the loop.'
WHERE `id` = 'ae901dbe45f8bf989bf20745887fc034f0545a3193d1926a5691e69f09ddb09a'
  AND `headline` = 'Google lists a new model, gemini-4-carbon — $1.00 in / $5.00 out per MTok';
--> statement-breakpoint
-- 2026-10-13 gemini-4-argon
UPDATE `alerts` SET
  `headline` = 'Google lists a new model, gemini-4-argon — $2.00 in / $10.00 out per MTok',
  `explanation` = 'gemini-4-argon appears for the first time in Google''s catalog (https://ai.google.dev/gemini-api/docs/pricing), listed as batch, flex, priority, standard. Its standard price moves to $4.00 in / $20.00 out per MTok on 2026-12-01. A model no catalog has listed before always alerts — the model-floor rule, no model in the loop.'
WHERE `id` = '32db086828737752198ea03756f76bc4f40f98a9f9f3624cf09bc1da869ec3b8'
  AND `headline` = 'Google lists a new model, gemini-4-argon — $1.00 in / $5.00 out per MTok';
--> statement-breakpoint
-- 2026-10-06 gemini-nano-banana-2.1
UPDATE `alerts` SET
  `headline` = 'Google lists a new model, gemini-nano-banana-2.1 — $1.50 in / $7.50 out per MTok',
  `explanation` = 'gemini-nano-banana-2.1 appears for the first time in Google''s catalog (https://ai.google.dev/gemini-api/docs/pricing), listed as batch, standard. A model no catalog has listed before always alerts — the model-floor rule, no model in the loop.'
WHERE `id` = '32570e190f48ea51c1a046939b4d4ce0187957e14c042003227340a2dc5c8590'
  AND `headline` = 'Google lists a new model, gemini-nano-banana-2.1 — $0.75 in / $3.75 out per MTok';
--> statement-breakpoint
-- 2026-09-23 gemini-3.8-flash-tts
UPDATE `alerts` SET
  `headline` = 'Google lists a new model, gemini-3.8-flash-tts — $0.50 in / $9.00 out per MTok',
  `explanation` = 'gemini-3.8-flash-tts appears for the first time in Google''s catalog (https://ai.google.dev/gemini-api/docs/pricing), listed as batch, flex, priority, standard. Its standard price moves to $1.00 in / $18.00 out per MTok on 2027-01-01. A model no catalog has listed before always alerts — the model-floor rule, no model in the loop.'
WHERE `id` = '123c3f13001c525559c40366bcae1c2f631ab15daab3931297ecb3a892725705'
  AND `headline` = 'Google lists a new model, gemini-3.8-flash-tts — $0.25 in / $4.50 out per MTok';
--> statement-breakpoint
-- 2026-09-23 gemini-3.8-flash-lite-tts
UPDATE `alerts` SET
  `headline` = 'Google lists a new model, gemini-3.8-flash-lite-tts — $0.50 in / $6.00 out per MTok',
  `explanation` = 'gemini-3.8-flash-lite-tts appears for the first time in Google''s catalog (https://ai.google.dev/gemini-api/docs/pricing), listed as batch, flex, priority, standard. Its standard price moves to $1.00 in / $12.00 out per MTok on 2027-01-01. A model no catalog has listed before always alerts — the model-floor rule, no model in the loop.'
WHERE `id` = 'bf28cc6feb585ca7d4cd31ed94f26d8f0da5b2130e667f90ce25c8b0d374f2af'
  AND `headline` = 'Google lists a new model, gemini-3.8-flash-lite-tts — $0.25 in / $3.00 out per MTok';
