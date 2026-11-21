# Data schema changelog

Changes to the columns of the exports at `/export/<table>.csv|json`, the bulk
feed at `/export/bulk/manifest.json`, and the JSON envelopes under `/api/*`.
Every one of those states its `schema_version`: a field in a JSON object, and
the `X-Schema-Version` header on a CSV or a JSON array. The same history is on
[/data](https://frontierterm.com/data#schema) and in `changelog` at
`/export/dictionary.json`.

## The promise

- Adding a table or a column is a minor version (1.0.0 to 1.1.0). Code that
  reads columns by name keeps working.
- Removing or renaming a table or a column is a major version (1.x to 2.0.0).
  It's listed here 90 days before it ships.
- Changing what a column holds without renaming it is a minor version, with a
  note saying what changed.
- A release that changes no column (a fix to how a value is read) is a patch.

The test in `layers/terminal/test/terminal-dictionary.test.ts` fails a build
whose columns or version don't match `schema.lock.json`, or whose version bump
is smaller than its changes need. `bun run schema:lock` rewrites the lock only
when the newest release in `layers/terminal/server/utils/data-schema.ts` says
exactly which columns changed.

## 1.15.0 (2026-11-21)

`/api/utilization` gains `benchmark_rounds`: every stored MLPerf Inference
round side by side (v5.1 and v6.0 today). A row is one accelerator on one
benchmark at one accelerator count, and `results` has one entry per round in
`rounds`, oldest first: the round's fastest result in tokens per second per
accelerator (our division, unverified by MLCommons), with its `result_id`,
`submitter` and `system`, or null where the round has none. `change` is the
newest result over the one before it, less one. Only accelerators with a
like-for-like result in two rounds have rows. `accelerators_left_out` counts
the rest, and `mixed_results` counts results from systems that mix
accelerators. `footnote` is the citation MLCommons requires, and `sources`
cites each round. It is null until two rounds are stored. `implied` still
reads the newest round alone. The MCP tool `get_utilization` returns it too.
No table columns changed.

## 1.14.0 (2026-11-21)

`/api/adoption` gains `weekly` on each `downloads` and `agent_prs` entry: the
total per ISO week (Monday to Sunday, UTC, keyed by its Monday) over every
day we have stored, oldest week first. It runs through the newest week whose
Sunday is on record, so the week still running is left out. `days` says how
many of the week's days are stored, and `partial` is true when one is
missing, so its `total` covers fewer days. An `agent_prs` week is also
`retrospective` when any of its days was counted later, from the pull
requests that still existed then. npm history starts 540 days before our
first read and PyPI history 180 days before it. The MCP tool `get_adoption`
returns it too. No table columns changed.

## 1.13.0 (2026-11-20)

GPU rental price history from before our GPU price checks began (2026-11-01),
read from the Internet Archive's weekly copies of each provider's own price
page. A new `archived_gpu_prices` table has one row per priced H100 or B200
configuration per copy, keyed and shaped like the live `gpu-*` rows in
`recipe_observations`, with the copy as `source_url`. `archive_captures.axis`
can now be `gpu`. The rows are CC BY-NC 4.0, like the other archived tables,
and a licence key doesn't relabel them. `/api/gpu-prices` gains `archived`
(null until the backfill has run).

## 1.12.0 (2026-11-20)

`/api/rankings` gains `weekly`: each lab's share of OpenRouter tokens per ISO
week (Monday to Sunday, UTC) over every day we have stored, oldest week
first. Each week has its `tokens` and `share` per lab, `other` included, the
same way `shares` counts them. `from`, `to` and `days` say which days of the
week are on record, so a partial week's share rests on fewer days. The MCP
tool `get_rankings` returns it too. No table columns changed, and the
per-model rows still aren't exported.

## 1.11.0 (2026-11-20)

`power_site_ties` keeps up with new filings. Its first rows were read by
hand. The filings lane now searches EDGAR each day for new 10-Qs, 10-Ks,
8-Ks, 20-Fs, 6-Ks and S-1s (and their press-release exhibits) that name each
of Epoch AI's lab sites, a model picks out the companies tied to the site's
power, and a row is kept only where its quote, the company, the site and any
megawatt figure are in the filing verbatim. Rows from a utility's,
regulator's or company's own page stay read by hand and are re-read weekly.

- New columns: `basis` (`hand` or `judge`), `accession_no`, `first_seen_at`,
  and `ended_at` and `ended_by`, set when the filer's next filing of the same
  periodic form no longer has the quote. An ended row stays in the table.
- Changed: when a newer filing of the same form repeats a quote word for
  word, the row's `source_url`, `published`, `source_title`, `publisher` and
  `fetched_at` move to that filing. The `id` stays the same. A row from a
  page off EDGAR has `fetched_at` moved by the weekly re-read.

## 1.10.0 (2026-11-20)

`supplier_passages` is read from the suppliers' own filings as they are
filed. Its first rows were read by hand. The filings lane now reads each
company's new 10-Q, 10-K, 8-K, 20-F and 6-K, a model picks out the
passages, and a row is kept only where its quote and every figure in it are
in the filing verbatim.

- New columns: `basis` (`hand` or `judge`), `accession_no`, `first_seen_at`,
  and `ended_at` and `ended_by`, set when the company's next filing of the
  same form no longer has the quote. An ended row stays in the table.
- Changed: when a newer filing of the same form repeats a quote word for
  word, the row's `source_url`, `filed`, `period`, `source_title` and
  `fetched_at` move to that filing. The `id` stays the same.

## 1.9.0 (2026-11-20)

Six new tables.

- `latency_probes`: every hourly probe we send each lab's flagship model
  through OpenRouter, with its outcome and the timings we measured. Our own
  measurements, so the whole table is ours to license.
- `probe_days`: the daily strain reading `/api/probes` serves, per lab and UTC
  day, rolled from `latency_probes`.
- `filed_guidance`: the capex guidance in each earnings release Microsoft,
  Alphabet, Amazon, Meta and Oracle furnish, one row per fiscal year, with the
  release's own sentence.
- `dependency_edges`: the lines of the graph on `/dependencies`, one row per
  filed figure a company's XBRL puts on a named counterparty.
- `supplier_passages`: the passages behind `/api/suppliers`, each with its
  quote and the SEC document it's in.
- `power_site_ties`: the companies and grids behind `/api/power-sites`, each
  with its quote and the page it's on.

The dictionary's `sources` gain the `power_site_sources` pages, in a new
`power_sites` group.

## 1.8.1 (2026-11-20)

A fix to how the latency probes in `/api/probes` are read. No columns changed.

- `ttft_ms` is the time to the first text of the answer, and
  `tokens_per_second` counts answer tokens only. Until now a lab that streams
  its reasoning (xAI) was timed to its first reasoning text, and its reasoning
  tokens were counted in throughput. Its readings before 2026-11-20 are not
  comparable with later ones.

## 1.8.0 (2026-11-19)

Press reports of deal sizes. `reported_figures.metric` gains `commitment`,
`investment`, `financing` and `commitment_total`, for the size of a compute,
investment or lending deal between a lab and another company.

- New: `reported_figures.counterparty`, the other company in a deal as the
  headline names it. Rows with the five earlier metrics are unchanged and
  carry a null `counterparty`.

## 1.7.0 (2026-11-11)

A fourth `rights` value, `restricted`: facts a publisher states about itself
on a public page its robots.txt doesn't close, where its site terms restrict
automated reading or we couldn't find them. Our license covers our
compilation of those rows with the restriction disclosed, never the saved
pages. 25 sources moved to it from `not-cleared`, among them the OpenAI,
Anthropic, xAI, Meta, DeepSeek, Alibaba and Moonshot docs. `rights` in
`/api/coverage` can now be `restricted`, and each table's `licensing` in
`/export/dictionary.json` gains a `restricted` list and can answer
`commercial: restricted`. No table columns changed.

## 1.6.0 (2026-11-07)

Press reports of the private labs’ revenue, valuations and funding, in two new
tables. `reported_articles` has each GDELT article whose headline names a lab
we track and an amount of money. `reported_figures` has each figure such a
headline states, labeled by our judge model with its lab, metric
(`revenue_run_rate`, `revenue`, `valuation`, `funding`, `funding_total`) and
basis (`reported`, `sought`, `projected`). A label is kept only when its
amount and lab are in the headline as written. These are unaudited press
figures, kept apart from filed revenue.

## 1.5.1 (2026-11-05)

The Parquet bulk files are compressed with gzip instead of zstd. zstd in the
Workers runtime failed on any page that compressed to more than about 40 KB,
so the largest tables (snapshots, jobs_open) had no Parquet file at all.
Parquet readers pick the codec up from each file, so nothing changes for you.
No columns changed, and a file built under 1.5.0 is still valid.

## 1.5.0 (2026-11-05)

Hiring history from before we read the labs' job boards, read from the
Internet Archive's copies of each lab's own board:

- `archived_hiring`: open roles per copy we could read. Each copy has one
  `board` row with the open roles on the whole board, and one `department`
  row per department when the copy lists every role. `label` is the
  department as the board printed it then. `department` is the live
  department it files under, where the board's own id ties the two.
  `source_url` is the copy, `captured_at` when the Archive saw the board,
  `fetched_at` when we read the copy, and `basis` is always `archived`.
- `archive_captures` gains `axis`: `pricing` (rows in `archived_prices`) or
  `hiring` (rows in `archived_hiring`). Every existing row is `pricing`.

## 1.4.0 (2026-11-05)

Identifiers for joining our tables to a security master:

- `entity_identifiers`: one row per company we name (each lab, each SEC filer
  we read, each comparison company). It has the legal name, country, listing
  status, CIK, LEI, and for a listed company the ticker, exchange, MIC,
  composite FIGI and share-class FIGI. Each identifier has its own
  `_source_url` and `_fetched_at`. A null LEI has its reason in `lei_note`.
  `entity_id` is the value of every `provider` and `company` column, so join
  on it. Tables that carry `cik` or `ticker` join on those too.
- `entity_securities` gains `mic`, `figi`, and `disclosed_in`, the filing that
  discloses a parent or an investor. It also gains a row for Alphabet’s stake
  in Anthropic, from the note purchase agreements in Anthropic’s S-1/A.
- `/api/identifiers` serves both tables, and the MCP server has a
  `get_identifiers` tool.
- The data dictionary now gives each table its grain, update cadence, event
  and knowledge time columns, where its history starts, the identifier
  columns to join on, and whether it can be used commercially.

## 1.3.0 (2026-11-05)

New: every bulk file is also a Parquet file. No table columns changed.

- Each manifest entry gains `parquet`: the URL, rows, bytes, SHA-256, build
  time and schema version of `/export/bulk/<recent|full>/<table>.parquet`.
  It has the same rows and columns as the CSV, in the same order.
- Columns are typed by the data dictionary: text as UTF-8 strings, integers as
  INT64, numbers as DOUBLE, dates as DATE, booleans as BOOLEAN, JSON as JSON,
  and timestamps as UTC instants in microseconds (`TIMESTAMP` with
  `isAdjustedToUTC`). A vendor timestamp's offset is kept in the CSV and JSON
  exports only. Cells are verbatim: the apostrophe the CSV puts before a cell
  a spreadsheet would run as a formula isn't there.
- Compressed with zstd. Each file's key-value metadata has
  `frontier_terminal.table`, `.history`, `.schema_version`, `.generated_at`,
  and `.license` (with `.license_older` where a `license` column labels rows).
  `archived_prices` and `archive_captures` keep CC BY-NC 4.0 on their older
  rows there too, with a key.
- Entries also gain `license_older` (what the `license` column labels rows
  older than the window) and `s3_key`. The keyed manifest gains `s3`.
- The bulk files answer `Range` requests, so a Parquet reader can fetch the
  footer and the columns it needs.
- Licensees can read the full-history files over S3 (Cloudflare R2) with
  read-only credentials issued with their key. The bucket holds
  `full/<table>.csv.gz`, `full/<table>.parquet` and `manifest.json`.

## 1.2.0 (2026-11-04)

Two new tables for API price history from before we watched the labs, read
from the Internet Archive's copies of each lab's own pricing page:

- `archived_prices`: one row per SKU per copy we could read, keyed like the
  live prices. `source_url` is the copy, `captured_at` when the Archive saw
  the page, `fetched_at` when we read the copy, and `basis` is always
  `archived`.
- `archive_captures`: every copy the backfill considered, read or skipped
  with the reason.

## 1.1.0 (2026-11-04)

New: alert webhooks. We POST each new alert at or above the
severity you chose to an https URL you give us. The body is versioned like the
exports, and its `schema_version` field is this one.

- `alert` has the columns of the `alerts` table except `change_ids`, plus
  `permalink`, `source_urls` and `change_count`. `alert.changes` holds the
  cited rows of the `changes` table (up to 100, all of them on the permalink).
- `license` is the same license split a request with your key gets.
- `event`, `delivery_id` and `sent_at` sit beside them, inside the signed body.
- No table columns changed.

## 1.0.0 (2026-11-04)

First versioned schema. Every export, bulk file, and API response states its
`schema_version` from here on.

- Every table keeps the columns it had. The data dictionary lists them.
- A full-history export (`?history=full`) adds a `license` column before
  `source_url`. A rebuilt export (`?as_of=`) adds `as_of_verified` to a table
  of current rows. Neither changes the default columns.
- New: the bulk feed (`/export/bulk/manifest.json`), one gzipped CSV per table,
  rebuilt daily.
