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

The test in `layers/core/test/terminal-dictionary.test.ts` fails a build
whose columns or version don't match `schema.lock.json`, or whose version bump
is smaller than its changes need. `bun run schema:lock` rewrites the lock only
when the newest release in `layers/core/server/utils/data-schema.ts` says
exactly which columns changed.

## 1.29.0 (2026-11-23)

`claim_status_changes` joins the export: the revision trail of every thesis
claim, one row each time its computed status changed, with the status it left,
the reading date and the reason. Rows are append-only; the newest per claim is
its status now. `source_url` is the thesis page and `fetched_at` is when the
change was recorded.

## 1.28.3 (2026-11-22)

PyPI downloads go back further. Each package is read back to its first day
(`anthropic` to 2023-02-09, `openai` to 2020-01-01), where the series began at
2026-04-08. Days before 2026-04-08 come from ClickPy, ClickHouse's public copy
of the PyPI downloads dataset, and later days from pypistats as before. Over
the 181 days both had on 2026-11-22 they matched on 114, and on the rest
ClickPy differed by under 1% on average and 3.2% at most. `source_url` on each
row says which one it came from. `recipe_observations` and `download_series`
gain the older days, and `weekly` on each `/api/adoption` downloads entry is
longer. No columns changed.

## 1.28.2 (2026-11-22)

npm downloads go back further. Each lab package is read back to its first
release (`@anthropic-ai/sdk` to 2023-01-31), and `openai`, the control
packages and `wrangler` to 2022-01-01, where the series began at 2025-05-13. `recipe_observations` and `download_series` gain the older days,
and `weekly` on each `/api/adoption` downloads entry is longer. No columns
changed.

## 1.28.1 (2026-11-21)

`/api/overview` and `get_overview` gain `lab_alerts`: each lab's newest notable
or critical alert, however far back, where `alerts` holds only the newest ten
overall. No columns changed.

## 1.28.0 (2026-11-21)

History before the live record. Two new tables:

- `archived_rate_limits` holds Anthropic's rate limits and usage tiers from
  Internet Archive copies of its rate-limit page, from March 2024 to
  2026-11-04, keyed as the live `limits-anthropic` rows are. `archive_captures`
  gains the axis value `limits`. `/api/limits` and `get_rate_limits` gain
  `archived` on each page: how many copies were read, their span, and each
  limit that moved between two copies.
- `filed_text_facts` holds what Amazon's 10-Qs and 10-Ks said about Anthropic
  in words, from 2023-10 until it tagged `amzn:AnthropicMember` in 2026-04:
  each figure with its sentence, and `primarily` where Amazon says the figure
  includes other companies. `/api/exposure` and `get_exposure` show them as
  series with `basis` `text`, each point quoting its sentence.

The dictionary's sources gain `wayback-limits` and `release-notes`.

## 1.27.0 (2026-11-21)

Forward calls. Two new tables:

- `forward_calls` holds each dated estimate of a company's revenue, capex or
  remaining performance obligations made before the filing, with every method
  run and its inputs as they stood. Rows are inserted once and never edited.
- `forward_call_scores` holds each method's error once a later 10-Q or 10-K
  settles the period, and whether the actual landed inside the call's range.

In `/api/signals`, each of `forward_calls` replaces `prior` with `inputs` and
adds `rule`, `kind`, `fiscal_year`, `fiscal_quarter` and `resolves_from`; the
payload gains `forward_rule`.

## 1.26.0 (2026-11-21)

`hardware_prints` gains Korea's monthly exports of HS 8542 (electronic
integrated circuits) to the world from UN Comtrade, January 2013 on: `series`
`kr_hs8542_exports`, `entity` `kr-semiconductors`, `window` `month`, in USD. It
is narrower than Korea Customs Service's semiconductor figure
(`kr_chip_exports`) and kept as its own series. `published_at` is the
`lastReleased` of Comtrade's dataset for the month; a re-release at a different
figure is the next `vintage`. `yoy_pct` is null, since Comtrade states none.
Each `/api/prints` series entry gains `series`, the series id, since an entity
can now carry two. Attribute "Source: UN Comtrade."

## 1.25.0 (2026-11-21)

Hiring at the listed companies around the labs. Two new tables:

- `listed_jobs` has every role the job boards of CoreWeave, Nebius, Galaxy,
  Hut 8, Cipher Digital, Cerebras, Astera Labs and Credo have listed since our
  first read, and Google's data-center roles, each classed as data-center work,
  infrastructure engineering or other, with when it was first listed and when
  it closed.
- `listed_hiring_reads` has each daily read's counts.

`/api/hiring/listed` and `get_listed_hiring` derive the weekly levels and their
change on the week before. The dictionary's sources gain
`listed_hiring_sources`.

## 1.24.0 (2026-11-21)

What management of the 45 listed companies around the labs guided on each
earnings call, scored against what they filed later. `filed_guidance` gains
the call rows: `source` is `exhibit` (an earnings 8-K or 6-K exhibit),
`transcript` or `remarks` (posted by the company) or `audio` (our machine
transcript of a replay the company posts as a file), with `metric`, `segment`,
`basis`, `unit`, `bound`, `fiscal_quarter`, `period_start`, `period_end`,
`speaker`, `at_ms`, `page`, `call_document_id`, `page_url` and `method`. The
release capex rows read `source` `release` and are otherwise unchanged; `low`
and `high` are now in `unit`. Two new tables: `guidance_resolutions`, the later
10-Q or 10-K figure that settles a row, with `error_share` (actual less the
guided midpoint, over the midpoint), and `call_documents`, every document read.
`/api/call-guidance` and `get_call_guidance` serve them.

## 1.23.0 (2026-11-21)

`hardware_prints` gains Korea's semiconductor exports from Korea Customs
Service: `series` `kr_chip_exports`, `entity` `kr-semiconductors`, for the
first 10 and 20 days of a month (`window` `d10`, `d20`) and the whole month,
in USD, with the stated year-on-year change. `published_at` is the release's
embargo time (보도시점), `ticker` and `due_on` are null. Only releases under
KOGL Type 1 (October 2026 on) are served. Attribute Korea Customs Service and
the release URL in `source_url`.

## 1.22.0 (2026-11-21)

A new table, `hardware_prints`: the monthly revenue of TSMC, Hon Hai, Quanta,
Wistron, Wiwynn, Gigabyte, Accton and Delta, each figure as a source first gave
it. A later, different figure for a month is a new row with the next
`vintage`, never an overwrite. `first_seen_at` is when our read first held it,
`published_at` the release time where the source states one (a 6-K's EDGAR
acceptance), and `due_on` the statutory deadline. TSMC's history from its 6-Ks
starts in 2015 and Accton's from its own page in July 2023. `/api/prints`
serves it with each company's sourced ties, and `get_hardware_prints` returns
the same.

## 1.21.0 (2026-11-21)

Grid load where the lab sites are. Two new tables:

- `grid_load_days` has EIA-930's adjusted hourly demand summed per balancing
  authority and local day, from 2018, for the authorities that hold a lab site.
- `ercot_large_load_facts` has ERCOT's own large-load figures (approved to
  energize, the sum of observed monthly peaks, the large-load queue), one row
  per figure per report, with its sentence.

`/api/grid-load` and `get_grid_load` derive monthly and weekly averages with the
change on a year before. The dictionary's sources gain `grid_load_sources`.

## 1.20.0 (2026-11-21)

A signal scorecard at /signals.

- New table `signal_results`, one row per series, ticker, horizon (1, 5, 20
  and 60 trading days) and sample (`in`, or `out` for the held-out newest
  third). `estimate` is the correlation between the series' change and the
  ticker's return less SPY's, or for an event series the mean abnormal
  return. A result under the minimum sample is `thin`, with no estimate.
- New route `/api/signals` and MCP tool `get_signals`: every registered
  series with its results, the number of tests run, and the forward calls.
- Statistics only. The daily closes behind them are licensed for internal use
  and aren't published.

## 1.19.0 (2026-11-21)

Package downloads made comparable. Raw counts of every growing package rise
together, so each lab package gets two derived reads.

- Five non-AI npm packages (react, typescript, express, lodash, axios) are read
  from 2025-05-13 as controls, under recipe ids `npm-control-*`.
- New table `download_series`, one row per series and day:
  `npm-control-index` (the controls' median, each against its own mean from
  2025-06-02 to 2025-06-29), `<recipe_id>-normalized` (npm downloads ÷ that
  index) and `<recipe_id>-share` (each lab's main SDK as a share of the
  tracked labs' main SDKs, on npm and on PyPI).
- `/api/adoption` gains, on each `downloads` entry, `normalized` and `share`
  per ISO week, `normalized_last_28d`, `normalized_prior_28d`, `share_28d` and
  `series` (the ids above), plus a `controls` block: the basket, its base
  weeks, its weekly index and npm's outage days. `get_adoption` returns them.
- A day npm reported as zero after a package's first download is an outage.
  Its `recipe_observations` row keeps the zero and gains `"outage": true` in
  `payload`. It is left out of weekly totals and 28-day sums, so a week with
  one is partial.
- Anthropic claim 7 and Cloudflare claim 2 read the normalized series.

## 1.18.0 (2026-11-21)

The latency probes now leave from one place, a Cloudflare data center in
eastern North America, instead of whichever data center ran the hourly job (15
in the first day). A lab's times no longer include a varying distance to the
router.

- `latency_probes` gains `placement` (`enam`, or `unpinned` for every probe
  before the change), `served_by_pinned` and `rate_limit_headers`.
- `probe_days` gains `placement`, now part of its key. A day is never read
  across placements, so the changeover day has a row for each. Rows from
  before the change have placement `unpinned`.
- `/api/probes` serves the pinned series as each lab's `days` and `window`,
  and the unpinned history apart, in `other_series`.

## 1.17.0 (2026-11-21)

Status-page incident history from before our status feed checks began
(2026-09-09 for OpenAI, Anthropic and Google, 2026-11-05 for DeepSeek and
xAI), read from the Internet Archive's copies of each lab's own feed. A new
`archived_incidents` table has one row per incident, keyed by the feed's own
id, in the state the newest copy gives it, with that copy as `source_url`.
`archive_captures.axis` can now be `status`, and its new `covers_from` column
says how far back a status copy reaches. The rows are CC BY-NC 4.0, like the
other archived tables, and a licence key doesn't relabel them.
`/api/incidents` gains `archived` (null until the backfill has run):
incidents per lab per month, and how much of each month the copies reach.
## 1.16.0 (2026-11-21)

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

## 1.15.0 (2026-11-21)

OpenAI moved its misalignment reports from alignment.openai.com to
openai.com/safety-alignment/misalignment-reports/, and its index stopped
printing each report's model and the context it was observed in. Each
report's own page still prints both:

- `disclosure_timelines` gains `model` and `observed_during`, verbatim from
  the report page's first line ("Internal research model · RL training").
- `disclosures.model` and `disclosures.observed_during` are null on OpenAI
  rows from 2026-11-20, and `disclosures.entry_url` points at the new address.
- `disclosure_timelines.disclosed_on` is also read from a "First posted"
  line, which most report pages now print, and `lines` drops "Last updated"
  as it drops "Report updated".

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
