-- Give a lab's own filings back to the lab. Every filing was stored under
-- provider 'other': the SEC lanes never passed one, so Anthropic's S-1, its
-- amendments and its 424B4 showed on /alerts under Lab "Other" once its CIK
-- resolved (a `filer` row). The lanes now read the lab off the filing's
-- whitelisted CIK (layers/terminal/server/pipeline/parsers/sec/revenue-filers.ts
-- › issuerProviderFor), and the next poll rewrites the entity rows. A change
-- row is never rewritten by a poll, so this sets the cited rows the alerts
-- already show, and the entity rows too so the pages agree before that poll.
--
-- Only a filing whose whitelisted CIK is a resolved lab's (a `filer` row's
-- cik) moves. A parent's filing (SpaceX, Alphabet) has no `filer` row and
-- stays 'other'. Change ids hash the entity and its content, never the
-- provider, so ids and provenance stay as stored. A second run is a no-op.
UPDATE `changes` SET `provider` = (
  SELECT f.`provider` FROM `entities` f
  WHERE f.`entity_type` = 'filer'
    AND json_extract(f.`payload`, '$.cik') =
      json_extract(coalesce(`changes`.`after_json`, `changes`.`before_json`), '$.whitelist_cik')
  LIMIT 1
)
WHERE `entity_type` = 'filing'
  AND `provider` = 'other'
  AND EXISTS (
    SELECT 1 FROM `entities` f
    WHERE f.`entity_type` = 'filer'
      AND json_extract(f.`payload`, '$.cik') =
        json_extract(coalesce(`changes`.`after_json`, `changes`.`before_json`), '$.whitelist_cik')
  );
--> statement-breakpoint
UPDATE `entities` SET `provider` = (
  SELECT f.`provider` FROM `entities` f
  WHERE f.`entity_type` = 'filer'
    AND json_extract(f.`payload`, '$.cik') = json_extract(`entities`.`payload`, '$.whitelist_cik')
  LIMIT 1
)
WHERE `entity_type` = 'filing'
  AND `provider` = 'other'
  AND EXISTS (
    SELECT 1 FROM `entities` f
    WHERE f.`entity_type` = 'filer'
      AND json_extract(f.`payload`, '$.cik') = json_extract(`entities`.`payload`, '$.whitelist_cik')
  );
