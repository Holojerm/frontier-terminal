-- MLPerf rows are now dated by their round's announcement, and the recipe
-- reads the oldest round newer than the newest stored date
-- (layers/terminal/server/theses/recipes/mlperf-inference.ts › nextMlperfRound).
-- The v6.0 rows stored so far carry the day they were fetched (2026-11-20),
-- which would keep v5.1 from ever being read. Clearing them lets the next two
-- survey runs read v5.1 and then v6.0 again. No thesis rates these rows, and
-- the raw bytes stay in R2. Only fetch-dated rows match: a row dated by its
-- round is on or before 2026-04-01.
DELETE FROM `recipe_observations` WHERE `recipe_id` = 'mlperf-inference-datacenter' AND `date` > '2026-04-01';
