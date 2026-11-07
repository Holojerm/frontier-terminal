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
  Licensees get 90 days' notice by email before it ships, and the release is
  listed here first.
- Changing what a column holds without renaming it is a minor version, with a
  note saying what changed.
- A release that changes no column (a fix to how a value is read) is a patch.

The test in `layers/terminal/test/terminal-dictionary.test.ts` fails a build
whose columns or version don't match `schema.lock.json`, or whose version bump
is smaller than its changes need. `bun run schema:lock` rewrites the lock only
when the newest release in `layers/terminal/server/utils/data-schema.ts` says
exactly which columns changed.

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
  columns to join on, and whether a licensee can use it commercially.

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

New: alert webhooks for licensees. We POST each new alert at or above the
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
