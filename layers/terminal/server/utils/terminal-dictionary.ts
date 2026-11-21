// The data dictionary: every exported column's type, meaning, unit, nullability
// and role, for /data, /export/dictionary.json and /export/dictionary.csv.
//
// Columns, their meanings, descriptions and the as_of mode come from
// EXPORT_TABLES, where each column is declared with its entry, so none can go
// undocumented. Only what the export code cannot say about itself is written
// here: how a cut table answers as_of, and each table's grain, cadence and
// licensing.

import type {
  DataDictionary,
  DictionaryColumn,
  DictionaryJoin,
  DictionaryTable,
  DictionaryType,
  SourceAxis,
  SourceLicensing,
  SourceRights,
} from '../../shared/utils/terminal-types'
import {
  DATA_LICENSE,
  HISTORY_LICENSE,
  HISTORY_PARAM,
  LICENSE_SPLIT_EFFECTIVE,
  LICENSE_WINDOW_DAYS,
} from '#shared/utils/license'
import { parseCikWhitelistBlock } from '../../../companies/server/pipeline/parsers/sec/whitelist'
import { SCHEMA_VERSION, schemaChangelog } from '#layers/core/server/utils/data-schema'
import { ALERTS_METHOD } from '#layers/core/server/utils/terminal-asof'
import {
  AS_OF_VERIFIED,
  AS_OF_VERIFIED_DOC,
  asOfColumns,
  type ExportTable,
} from '#layers/core/server/utils/terminal-export-views'
import { EXPORT_TABLES } from '#server/registries/export-tables'
import { LICENSE_COLUMN, historyRule } from '#layers/core/server/utils/terminal-export-history'
import { csvLine } from '#layers/core/server/utils/terminal-export-format'
import { JOINING_NOTE } from '../../../companies/server/utils/terminal-identifiers'
import {
  readArchiveSources,
  readFiledFactSources,
  readIdentifierSources,
  readGridLoadSources,
  readListedHiringSources,
  readPowerSiteSources,
  readPrintSources,
  readCallSources,
  readSourceRegistry,
} from '#layers/core/server/utils/terminal-sources'

/** Served at /export/dictionary.json and .csv; no export table may take the name. */
export const DICTIONARY_NAME = 'dictionary'

export const DATA_TYPES: Readonly<Record<DictionaryType, string>> = {
  text: 'A string.',
  integer: 'A whole number.',
  number: 'A decimal number, as the source states it. We never round it.',
  timestamp:
    'An ISO-8601 timestamp with its zone (Z or ±hh:mm). Stamps we write are UTC. Stamps read from a vendor keep the vendor’s offset.',
  date: 'A calendar date, YYYY-MM-DD.',
  json: 'Structured data. Nested in the JSON export and JSON text in a CSV cell, except where the meaning says the column is JSON text in both.',
  boolean: 'true or false, as the words true and false in a CSV cell.',
}

export const PROVENANCE_NOTE =
  'Every row ends with source_url, the URL it was read from, and fetched_at, when that fetch ran. source_runs has started_at instead, since a failed run fetched nothing. entity_securities has checked_on, since its rows are hand-checked. entity_identifiers also gives each identifier its own source URL and fetch time. In a CSV an empty cell is null.'

export const LICENSE_NOTE =
  `Rows dated in the last ${LICENSE_WINDOW_DAYS} days are ${DATA_LICENSE.short}. ` +
  `A table that grows over time downloads only those rows by default. Add ?${HISTORY_PARAM}=full for every row. ` +
  `That download adds a ${LICENSE_COLUMN} column before source_url: ${HISTORY_LICENSE.id} for a row dated before the window that we first published on or after ${LICENSE_SPLIT_EFFECTIVE}, ${DATA_LICENSE.id} for the rest. ` +
  'Tables of current rows and lookups download whole. Rebuilt at an as_of before the window, they get the same column. ' +
  'Upstream data keeps its own license.'

const REBUILT_NOTE =
  'Rebuilt from the current rows and the change log. For each key we take the content the first change after as_of replaced, else the current row if it was written by then. The view gains an as_of_verified column. False marks a key whose state the log does not confirm.'

// ---- as_of ---------------------------------------------------------------------

/** How each `cut` table is cut at as_of. Rebuilt and refused tables say so from the export. */
const AS_OF_CUT: Readonly<Record<string, string>> = {
  snapshots: 'Rows with fetched_at at or before as_of.',
  changes: 'Rows with detected_at at or before as_of.',
  alerts: ALERTS_METHOD,
  claim_verdicts:
    'Verdicts with detected_at and judged_at both at or before as_of: a verdict is held back until it was judged.',
  track_record_candidates: 'Rows with found_at at or before as_of.',
  track_record_verdicts: 'Rows with judged_at at or before as_of.',
  reported_articles: 'Rows with found_at at or before as_of.',
  reported_figures: 'Rows with judged_at at or before as_of.',
  latency_probes: 'Rows with started_at at or before as_of.',
  ercot_large_load_facts: 'Rows with fetched_at at or before as_of: when we read the report.',
  hardware_prints:
    'Rows with first_seen_at at or before as_of: each month as we held it then. A backfilled row was read after its release, so for it published_at, where set, is the release time.',
  listed_hiring_reads: 'Rows with read_at at or before as_of: when we read the board.',
  filed_facts:
    'Rows whose filing date is before the UTC day of as_of. A fact counts from the day after its filing, whenever we read it, so this table answers as_of back to 2019.',
  filed_text_facts:
    'Rows whose filing date is before the UTC day of as_of. A figure counts from the day after its filing, whenever we read it, so this table answers as_of back to 2023-10.',
  filed_guidance:
    'Rows whose release or call was filed or held before the UTC day of as_of. A figure counts from the day after it was stated, whenever we read it, so this table answers as_of back to 2024 for the release capex and to 2018 for the calls.',
  guidance_resolutions:
    'Rows with first_seen_at at or before as_of: a guided figure as settled by what we held then.',
  forward_calls:
    'Rows with recorded_at at or before as_of: the calls made by then. A registered call is dated the day it was committed.',
  forward_call_scores: 'Rows with first_seen_at at or before as_of: each call as settled then.',
  call_documents: 'Rows with first_seen_at at or before as_of.',
  exposure_quarters:
    'Built from the filed_facts rows filed before the UTC day of as_of, so it answers back to 2019.',
  dependency_edges:
    'Built from the filed_facts rows filed before the UTC day of as_of: the graph as the filings stood then.',
  archived_prices:
    'Rows with captured_at at or before as_of: when the Internet Archive saw the page, not when we read the copy (fetched_at, always later). So a backtest gets the page as it stood then, which this site did not hold at the time.',
  archived_hiring:
    'Rows with captured_at at or before as_of: when the Internet Archive saw the board, not when we read the copy (fetched_at, always later). So a backtest gets the board as it stood then, which this site did not hold at the time.',
  archived_gpu_prices:
    'Rows with captured_at at or before as_of: when the Internet Archive saw the provider’s price page, not when we read the copy (fetched_at, always later). So a backtest gets the page as it stood then, which this site did not hold at the time.',
  archived_incidents:
    'Rows with captured_at at or before as_of: when the Internet Archive took the newest copy listing the incident, not when we read it (fetched_at, always later). A row holds the newest copy’s state only, so a backtest at an earlier as_of misses incidents whose newest copy is later, and gets no older state of the rest.',
  archived_rate_limits:
    'Rows with captured_at at or before as_of: when the Internet Archive saw the rate-limit page, not when we read the copy (fetched_at, always later). So a backtest gets the page as it stood then, which this site did not hold at the time.',
  archive_captures:
    'Rows with captured_at at or before as_of: when the Internet Archive saw the page, not when we read the copy.',
  source_runs: 'Rows with started_at at or before as_of.',
}

// ---- per-table facts for an institutional reader --------------------------------

/** Which sources a table's rows come from, for its licensing answer. */
type Feed =
  /** Records of our own checks (what we fetched and when), whatever the source. */
  | 'own'
  /** Every include source in sources.yaml. */
  | 'all'
  | 'recipes'
  | 'track_record'
  | 'archive'
  | 'filed_facts'
  | 'identifiers'
  | 'power_sites'
  | 'grid_load'
  | 'prints'
  | 'calls'
  | 'listed_hiring'
  | { axes: readonly SourceAxis[] }
  /** Named sources, by id. */
  | { ids: readonly string[] }

interface TableMeta {
  /** One row per what. */
  grain: string
  cadence: string
  /** The column dating the thing the row describes, as the source dates it. Null when the row is only an observation. */
  event: string | null
  /** The column dating when we (or the public, for a filing) first had the row. */
  knowledge: string
  /** Where the history starts, live and archived. */
  start: string
  joins: readonly DictionaryJoin[]
  feeds: readonly Feed[]
  /** Which columns come from which source, where a table mixes them by column. */
  licenseNote?: string
}

const ID = 'entity_identifiers.entity_id'
const byProvider: DictionaryJoin = { column: 'provider', to: ID }
const byCik: DictionaryJoin = { column: 'cik', to: 'entity_identifiers.cik' }
const byTicker: DictionaryJoin = { column: 'ticker', to: 'entity_identifiers.ticker' }

const LIVE = 'From our first check of each source.'
const SURVEY = 'Every 6 hours, with the full check of every source.'
const SEC_FEEDS = 'Every 30 minutes with the SEC feeds, and again every 6 hours.'
const sec: Feed = { axes: ['sec'] }
const prospectus = (grain: string): TableMeta => ({
  grain,
  cadence: SEC_FEEDS,
  event: 'filed',
  knowledge: 'first_seen_at',
  start: 'From each lab’s first registration filing we read (Anthropic’s S-1 of 2026-10-26).',
  joins: [byProvider, byCik],
  feeds: [sec],
})

export const TABLE_META: Readonly<Record<string, TableMeta>> = {
  snapshots: {
    grain: 'One row per fetch of a source.',
    cadence:
      'Model catalogs up to every 5 minutes, SEC feeds and lab price lists every 30, everything else every 6 hours.',
    event: null,
    knowledge: 'fetched_at',
    start: LIVE,
    joins: [],
    feeds: ['own'],
  },
  prices_latest: {
    grain: 'One row per SKU per source, as of the last check.',
    cadence:
      'Model catalogs every 5 minutes when they change, lab price lists every 30 minutes, every source every 6 hours.',
    event: 'effective_from',
    knowledge: 'first_seen_at',
    start:
      'Current rows only. Past prices are in changes (from our first check) and archived_prices (Internet Archive copies from January 2023).',
    joins: [byProvider],
    feeds: [{ axes: ['pricing-catalog', 'pricing-cross-check'] }],
  },
  jobs_open: {
    grain: 'One row per open role per job board.',
    cadence: SURVEY,
    event: 'published_at',
    knowledge: 'first_seen_at',
    start:
      'Current roles only. Roles that closed are in changes, from our first check. Open-role counts before then are in archived_hiring (Internet Archive copies from January 2023).',
    joins: [byProvider],
    feeds: [{ axes: ['hiring'] }],
  },
  incidents: {
    grain: 'One row per status-page incident.',
    cadence: SURVEY,
    event: 'started_at',
    knowledge: 'first_seen_at',
    start: 'What each feed listed at our first check, and every incident since.',
    joins: [byProvider],
    feeds: [{ axes: ['status'] }],
  },
  disclosures: {
    grain: 'One row per entry on a lab’s misalignment-disclosure index.',
    cadence: SURVEY,
    event: 'listed_on',
    knowledge: 'first_seen_at',
    start: 'Every entry the index lists, back to its first.',
    joins: [byProvider],
    feeds: [{ axes: ['disclosures'] }],
  },
  disclosure_timelines: {
    grain: 'One row per disclosure report page.',
    cadence: SURVEY,
    event: 'disclosed_on',
    knowledge: 'first_seen_at',
    start: 'Every report the index links to.',
    joins: [byProvider],
    feeds: [{ axes: ['disclosures'] }],
  },
  latency_probes: {
    grain: 'One row per probe: one streaming request to one lab’s flagship model.',
    cadence: 'Hourly, one probe per lab.',
    event: 'started_at',
    knowledge: 'fetched_at',
    start: 'From our first probe of each lab, in November 2026.',
    joins: [{ column: 'lab', to: ID }],
    feeds: ['own'],
  },
  probe_days: {
    grain: 'One row per lab and UTC day.',
    cadence: 'Rolled again from latency_probes after every hourly run, for the days it touched.',
    event: 'day',
    knowledge: 'fetched_at',
    start: 'From our first probe of each lab, in November 2026.',
    joins: [{ column: 'lab', to: ID }],
    feeds: ['own'],
  },
  filers: {
    grain: 'One row per lab whose CIK we found in its own registration filing.',
    cadence: SEC_FEEDS,
    event: 'resolved_file_date',
    knowledge: 'first_seen_at',
    start: 'From the first registration filing we found for each lab.',
    joins: [byProvider, byCik],
    feeds: [sec],
  },
  revenue_facts: {
    grain: 'One row per XBRL revenue fact per filing.',
    cadence:
      'Company facts every 30 minutes with the SEC feeds. Segment revenue from each 10-Q and 10-K every 6 hours.',
    event: 'end',
    knowledge: 'first_seen_at',
    start: 'Every revenue fact in EDGAR company facts, as far back as each filer tagged it.',
    joins: [byProvider, byCik],
    feeds: [{ axes: ['revenue'] }],
  },
  prospectus_statements: prospectus('One row per filing, period, and statement line.'),
  prospectus_commitments: prospectus('One row per filing, schedule line, and year bucket.'),
  prospectus_concentration: prospectus('One row per filing, basis, customer, and period.'),
  prospectus_shares: prospectus('One row per filing and share-count line.'),
  prospectus_risk_factors: prospectus('One row per filing and risk-factor heading.'),
  changes: {
    grain: 'One row per tracked item added, removed, or modified.',
    cadence: 'A check that finds a difference adds rows. Rows are never edited.',
    event: null,
    knowledge: 'detected_at',
    start: LIVE,
    joins: [byProvider],
    feeds: ['all'],
  },
  alerts: {
    grain: 'One row per alert.',
    cadence:
      'Written when a check finds a change that meets a rule. Judged alerts follow when the judge runs.',
    event: null,
    knowledge: 'created_at',
    start: LIVE,
    joins: [],
    feeds: ['all'],
  },
  claim_readings: {
    grain: 'One row per thesis claim and data date.',
    cadence: SURVEY,
    event: 'date',
    knowledge: 'computed_at',
    start: 'From the first data date each claim’s recipe reads.',
    joins: [],
    feeds: ['all', 'recipes'],
  },
  claim_verdicts: {
    grain: 'One row per candidate event the judge rated for a claim.',
    cadence: 'When the judge runs.',
    event: 'detected_at',
    knowledge: 'judged_at',
    start: LIVE,
    joins: [byProvider],
    feeds: ['all', 'recipes'],
  },
  track_record_candidates: {
    grain: 'One row per article or newsroom post found for an alert.',
    cadence:
      'Press articles from GDELT’s files, read twice an hour while an alert’s window is open. Newsroom posts within 5 minutes of the window closing.',
    event: 'published_at',
    knowledge: 'found_at',
    start: 'From the first notable or critical alert.',
    joins: [],
    feeds: ['track_record'],
  },
  track_record_verdicts: {
    grain: 'One row per candidate the judge rated.',
    cadence: 'When the judge runs.',
    event: null,
    knowledge: 'judged_at',
    start: 'From the first rated candidate.',
    joins: [],
    feeds: ['track_record'],
  },
  reported_articles: {
    grain: 'One row per article URL.',
    cadence: 'Hourly, as each GDELT file is read.',
    event: 'published_at',
    knowledge: 'found_at',
    start:
      'From GDELT’s files of 2026-09-01, read again for figures from 2026-11-07. Back to 2023-01-01 on the days whose hourly sample carried figure headlines, and the day either side, read from 2026-11-21 (found_at says when).',
    joins: [],
    feeds: ['track_record'],
  },
  reported_figures: {
    grain: 'One row per figure a headline states.',
    cadence: 'When the judge runs.',
    event: 'published_at',
    knowledge: 'judged_at',
    start: 'From the first headline the judge read.',
    joins: [{ column: 'lab', to: ID }],
    feeds: ['track_record'],
  },
  recipe_observations: {
    grain: 'One row per recipe, key, and date.',
    cadence: SURVEY,
    event: 'date',
    knowledge: 'first_seen_at',
    start:
      'Depends on the recipe. Some read a full history at their first run, others start at it.',
    joins: [{ column: 'company', to: ID }],
    feeds: ['recipes'],
  },
  download_series: {
    grain: 'One row per series and day.',
    cadence: 'Rebuilt from recipe_observations on each request.',
    event: 'date',
    knowledge: 'fetched_at',
    start: 'npm series from 2025-05-13, PyPI shares from the first PyPI day stored.',
    joins: [{ column: 'company', to: ID }],
    feeds: ['recipes'],
  },
  filed_facts: {
    grain: 'One row per XBRL fact per filing.',
    cadence: 'Every 30 minutes. Company facts every 6 hours.',
    event: 'end',
    knowledge: 'filed',
    start:
      'Company facts as far back as the filer tagged them, and each 10-Q and 10-K instance from 2020.',
    joins: [byTicker, byCik],
    feeds: ['filed_facts'],
  },
  filed_text_facts: {
    grain: 'One row per figure a filing states about a lab in words, per filing.',
    cadence:
      'Read once: Amazon’s 10-Qs and 10-Ks from 2023-10-27 to 2026-02-06, a few a run of the filed-facts reader.',
    event: 'end',
    knowledge: 'filed',
    start:
      'Amazon’s 10-Q for the quarter to 2023-09-30, the first to name Anthropic, to its 10-K for 2025. From its 10-Q of 2026-04-30 Amazon tags Anthropic (filed_facts).',
    joins: [byTicker, byCik],
    feeds: ['filed_facts'],
  },
  filed_guidance: {
    grain:
      'One row per figure: a release’s capex for a fiscal year (source release), or a metric and period a call document guides.',
    cadence:
      'Release capex every 30 minutes with the filed-facts read. Call documents hourly, up to eight a run; a replay the run after AssemblyAI finishes it.',
    event: 'filed',
    knowledge: 'filed',
    start:
      'Release capex from 2024-01-01; the calls of the 45 listed companies from 2018, as each company’s filings and posted files reach.',
    joins: [byTicker, byCik],
    feeds: ['filed_facts', 'calls'],
  },
  guidance_resolutions: {
    grain: 'One row per call guidance row a later filing settled.',
    cadence: 'Hourly, once the guided period’s 10-Q or 10-K is in XBRL.',
    event: 'filed',
    knowledge: 'first_seen_at',
    start: 'Guidance from calls held from 2018, as each company’s filings and posted files reach.',
    joins: [byTicker],
    feeds: ['filed_facts'],
  },
  call_documents: {
    grain: 'One row per document or replay an earnings call is read from.',
    cadence:
      'Hourly: new EDGAR exhibits for three companies a run, and every curated document once.',
    event: 'call_date',
    knowledge: 'first_seen_at',
    start: 'Calls held from 2018, as each company’s filings and posted files reach.',
    joins: [byTicker],
    feeds: ['calls', 'filed_facts'],
  },
  exposure_quarters: {
    grain: 'One row per series and period.',
    cadence: 'Rebuilt from filed_facts on each request.',
    event: 'end',
    knowledge: 'filed',
    start: 'From 2020.',
    joins: [byTicker],
    feeds: ['filed_facts'],
  },
  dependency_edges: {
    grain: 'One row per figure on a line of the dependency graph.',
    cadence: 'Rebuilt from filed_facts on each request.',
    event: 'end',
    knowledge: 'filed',
    start: 'The newest filed figure of each series only. Earlier periods are in exposure_quarters.',
    joins: [{ column: 'reporter', to: 'entity_identifiers.ticker' }],
    feeds: ['filed_facts'],
  },
  archived_prices: {
    grain: 'One row per SKU per Internet Archive copy we could read.',
    cadence: 'Once per backfill run, not on a schedule.',
    event: 'captured_at',
    knowledge: 'fetched_at',
    start:
      'Archived only. From the oldest copy we could read. The backfill looks at one copy a week from January 2023 to 2026-08-25.',
    joins: [byProvider],
    feeds: [{ ids: ['wayback-pricing'] }],
  },
  archived_hiring: {
    grain:
      'One board row per Internet Archive copy of a lab’s job board we could read, and one row per department when the copy lists every role.',
    cadence: 'Once per backfill run, not on a schedule.',
    event: 'captured_at',
    knowledge: 'fetched_at',
    start:
      'Archived only. From the oldest copy we could read (OpenAI 2023-01-08). The backfill looks at one copy a week from January 2023 to the day we began reading each board.',
    joins: [byProvider],
    feeds: [{ ids: ['wayback-hiring'] }],
  },
  archived_gpu_prices: {
    grain:
      'One row per priced H100 or B200 configuration per Internet Archive copy of a GPU provider’s price page we could read.',
    cadence: 'Once per backfill run, not on a schedule.',
    event: 'captured_at',
    knowledge: 'fetched_at',
    start:
      'Archived only. From the oldest copy we could read (Lambda, June 2023). The backfill looks at one copy a week from January 2023 to 2026-11-01, the first day of the live GPU price checks.',
    joins: [byProvider],
    feeds: [{ ids: ['wayback-gpu'] }],
  },
  archived_incidents: {
    grain:
      'One row per incident any Internet Archive copy of a lab’s status feed listed, in the newest such copy’s state.',
    cadence: 'Once per backfill run, not on a schedule.',
    event: 'started_at',
    knowledge: 'fetched_at',
    start:
      'Archived only. From the oldest copy of each feed (OpenAI and Anthropic from January 2023, DeepSeek from June 2024, xAI from January 2025, Google Cloud’s copies each reaching a year back) to the day each live status lane began. Mistral has no copies.',
    joins: [byProvider],
    feeds: [{ ids: ['wayback-status'] }],
  },
  archived_rate_limits: {
    grain:
      'One row per limit per Internet Archive copy of a lab’s rate-limit page we could read: per-model rates where the copy names the tier, and the usage-tier table.',
    cadence: 'Once per backfill run, not on a schedule.',
    event: 'captured_at',
    knowledge: 'fetched_at',
    start:
      'Archived only. Anthropic from March 2024 (the oldest copy that reads) to 2026-11-04, the first run of the live limits recipes. OpenAI’s, xAI’s and Meta’s pages have no copies that read.',
    joins: [byProvider],
    feeds: [{ ids: ['wayback-limits'] }],
  },
  archive_captures: {
    grain: 'One row per Internet Archive copy the backfill considered.',
    cadence: 'Once per backfill run, not on a schedule.',
    event: 'captured_at',
    knowledge: 'fetched_at',
    start:
      'Archived only. One copy a week per lab pricing page, job board or GPU provider price page, and every copy of each lab’s status feed (one a month for Google Cloud), from January 2023 to the day we began reading it.',
    joins: [byProvider],
    feeds: ['archive'],
  },
  source_runs: {
    grain: 'One row per check of a source.',
    cadence:
      'Model catalogs up to every 5 minutes, SEC feeds and lab price lists every 30, everything else every 6 hours.',
    event: null,
    knowledge: 'started_at',
    start: LIVE,
    joins: [],
    feeds: ['own'],
  },
  entity_securities: {
    grain: 'One row per tracked company and security that carries it (or none).',
    cadence: 'By hand, when a mapping changes.',
    event: null,
    knowledge: 'checked_on',
    start: 'The current mapping only.',
    joins: [
      { column: 'entity', to: ID },
      { column: 'cik', to: 'entity_identifiers.cik' },
      { column: 'figi', to: 'your security master' },
    ],
    feeds: [{ ids: ['sec-identifiers', 'openfigi-mapping'] }],
    licenseNote: 'figi and mic come from OpenFIGI. Everything else comes from SEC filings.',
  },
  signal_results: {
    grain: 'One row per series, ticker, horizon and sample.',
    cadence: 'Recomputed whole once a day, after the US close.',
    event: 'to_date',
    knowledge: 'fetched_at',
    start: 'Each series from its own first observation; prices from 2018-05-01 or the listing.',
    joins: [{ column: 'ticker', to: 'entity_identifiers.ticker' }],
    feeds: ['own'],
  },
  forward_calls: {
    grain: 'One row per forward call.',
    cadence: 'Registered calls with each deploy; rule calls on the daily run after the US close.',
    event: 'period_end',
    knowledge: 'recorded_at',
    start: '2026-11-20, the first call.',
    joins: [{ column: 'ticker', to: 'entity_identifiers.ticker' }],
    feeds: ['own', 'filed_facts', 'calls', 'prints'],
    licenseNote:
      'methods are ours. inputs quote filed figures, call guidance and hardware prints under their own sources’ terms; a print held under its source’s terms has no value.',
  },
  forward_call_scores: {
    grain: 'One row per forward call and method, once the period is filed.',
    cadence: 'Daily, after the US close, from the XBRL the call reader holds.',
    event: 'filed',
    knowledge: 'first_seen_at',
    start: 'The first filing after 2026-11-20 that settles a call.',
    joins: [],
    feeds: ['own', 'filed_facts'],
  },
  entity_identifiers: {
    grain: 'One row per company we name.',
    cadence: 'By hand, when a company’s identifiers change.',
    event: null,
    knowledge: 'fetched_at',
    start: 'The current registry only.',
    joins: [
      { column: 'cik', to: 'your security master' },
      { column: 'lei', to: 'your security master' },
      { column: 'figi', to: 'your security master' },
      { column: 'ticker', to: 'your security master' },
    ],
    feeds: ['identifiers'],
    licenseNote:
      'CIK, ticker, and exchange come from SEC, lei from GLEIF, and figi and mic from OpenFIGI. legal_name and country come from GLEIF too, except on a row with no LEI, where they come from the company’s own terms page.',
  },
  supplier_passages: {
    grain: 'One row per passage in a company’s own SEC document that ties it to a lab or a cloud.',
    cadence:
      'Six-hourly. The filings lane reads each company’s new filings and the judge reads the passages from them; a row ends when the next filing of its form drops the quote.',
    event: 'filed',
    knowledge: 'fetched_at',
    start: 'The hand read of 2026-11-19 and 2026-11-20, then every filing since.',
    joins: [
      { column: 'counterparty_lab', to: ID },
      { column: 'ticker', to: 'your security master' },
    ],
    feeds: [{ ids: ['edgar-submissions'] }],
  },
  power_site_ties: {
    grain:
      'One row per company a page ties to a lab’s data-center site, and one per site whose grid a page names.',
    cadence:
      'Daily for SEC filings. We search EDGAR for new filings naming each site once a day, and a model reads the ties from them. A row ends when the filer’s next filing of its form drops the quote. Weekly for every other page. We re-read it, restamp fetched_at, and flag a quote that is gone.',
    event: 'published',
    knowledge: 'fetched_at',
    start: 'The hand read of 2026-11-19 and 2026-11-20, then every SEC filing naming a site since.',
    joins: [{ column: 'ticker', to: 'your security master' }],
    feeds: ['power_sites'],
  },
  grid_load_days: {
    grain: 'One row per balancing authority and local day.',
    cadence:
      'Six-hourly. We read EIA’s API from six weeks before the newest day we hold, or the current six-month file when the API fails. A day EIA revises is rewritten in place.',
    event: 'date',
    knowledge: 'fetched_at',
    start: '2018-01-01: 2018 from EIA’s six-month files, 2019 on from its API.',
    joins: [],
    feeds: [{ ids: ['eia930-api', 'eia930-balance'] }],
  },
  ercot_large_load_facts: {
    grain: 'One row per figure an ERCOT report states, per report.',
    cadence:
      'Six-hourly checks of ERCOT’s Board and presentations pages. A report is read once, when it is first linked.',
    event: 'posted',
    knowledge: 'fetched_at',
    start:
      'ERCOT’s Monthly Operational Overview from January 2025 and its ERCOT Monthly from November 2025.',
    joins: [],
    feeds: [{ ids: ['ercot-large-loads'] }],
  },
  hardware_prints: {
    grain:
      'One row per figure a source gave for a company’s month (or Korea’s chip exports for a month or its first 10 or 20 days), each vintage its own row.',
    cadence:
      'Hourly. Taiwan revenue is due by the 10th of the next month, and TSMC files its 6-K the same day. Korea Customs Service posts the 10-day figure on the 11th, the 20-day figure on the 21st and the confirmed month around the 15th.',
    event: 'period',
    knowledge: 'first_seen_at',
    start:
      'TSMC from January 2015 (its 6-Ks), Accton from July 2023 (its own page), the others from our first read of the exchange feed on 2026-11-21. Korea’s chip exports from September 2026, the first releases under KOGL Type 1.',
    joins: [
      { column: 'ticker', to: 'your security master' },
      { column: 'entity', to: 'your security master' },
    ],
    // The figures' sources. The ties aren't rows of this table, and the held KCS releases are never exported.
    feeds: [
      {
        ids: [
          'twse-monthly-revenue',
          'tsmc-revenue-6k',
          'accton-monthly-revenue',
          'kcs-chip-exports',
        ],
      },
    ],
  },
  listed_jobs: {
    grain: 'One row per role a listed company’s job board has listed, open or closed.',
    cadence: 'Daily at 04:00 UTC, one request per board.',
    event: 'published_at',
    knowledge: 'first_seen_at',
    start: 'Our first read of each board, 2026-11-21. Roles that closed before then are not here.',
    joins: [],
    feeds: ['listed_hiring'],
  },
  listed_hiring_reads: {
    grain: 'One row per read of a listed company’s job board.',
    cadence: 'Daily at 04:00 UTC.',
    event: 'read_at',
    knowledge: 'read_at',
    start: 'Our first read of each board, 2026-11-21.',
    joins: [],
    feeds: ['listed_hiring'],
  },
}

export const TIME_NOTE =
  'Event time is when the thing happened, as the source dates it. Knowledge time is when the row first existed for us (or, for a filing, when it was filed). ?as_of= cuts on knowledge time.'

// ---- commercial use, from sources.yaml rights -----------------------------------

const OURS_TERMS = `The last ${LICENSE_WINDOW_DAYS} days are ${DATA_LICENSE.short} for anyone. Older rows are ${HISTORY_LICENSE.short}, for non-commercial use only.`

const RIGHTS_ANSWER: Readonly<Record<SourceRights, string>> = {
  ours: `Yes. ${OURS_TERMS}`,
  restricted: `Yes, with a restriction we disclose. The publisher’s site terms restrict automated reading, or we couldn’t find them. Our license covers our compilation of these rows, not the saved pages. ${OURS_TERMS}`,
  upstream: 'Under its own license, which we pass on.',
  'not-cleared': 'No. It stays on the free site, and our license doesn’t cover it.',
}

interface Rated {
  id: string
  group: SourceLicensing['group']
  axis: SourceAxis | null
  rights: SourceRights | null
  license: string | null
}

/** Every source sources.yaml rates, flattened. */
function ratedSources(sourcesYaml: string): Rated[] {
  const registry = readSourceRegistry(sourcesYaml)
  const flat =
    (group: SourceLicensing['group']) => (s: { id: string; rights: SourceRights | null }) => ({
      id: s.id,
      group,
      axis: null,
      rights: s.rights,
      license: null,
    })
  return [
    ...registry.sources.map((s) => ({
      id: s.source_id,
      group: 'sources' as const,
      axis: s.axis,
      rights: s.rights,
      license: s.license,
    })),
    ...registry.recipes.map((r) => flat('recipes')({ id: r.recipe_id, rights: r.rights })),
    ...registry.track_record.map(flat('track_record')),
    ...readArchiveSources(sourcesYaml).map(flat('archive')),
    ...readFiledFactSources(sourcesYaml, parseCikWhitelistBlock(sourcesYaml)).map(
      flat('filed_facts'),
    ),
    ...readIdentifierSources(sourcesYaml).map((s) => ({
      ...flat('identifiers')(s),
      license: s.license,
    })),
    ...readPowerSiteSources(sourcesYaml).map(flat('power_sites')),
    ...readGridLoadSources(sourcesYaml).map(flat('grid_load')),
    ...readPrintSources(sourcesYaml).map((s) => ({
      ...flat('prints')(s),
      license: s.license,
    })),
    ...readCallSources(sourcesYaml).map(flat('calls')),
    ...readListedHiringSources(sourcesYaml)
      .filter((s) => s.verdict.startsWith('include'))
      .map(flat('listed_hiring')),
  ]
}

function sourceAnswer(s: Rated): string {
  if (s.rights === 'upstream' && s.license) return `Under its own license: ${s.license}.`
  return s.rights ? RIGHTS_ANSWER[s.rights] : 'Not rated in sources.yaml.'
}

function feeds(f: Feed, s: Rated): boolean {
  if (f === 'own') return false
  if (f === 'all') return s.group === 'sources'
  if (typeof f === 'string') return s.group === f
  if ('ids' in f) return f.ids.includes(s.id)
  return s.group === 'sources' && s.axis !== null && f.axes.includes(s.axis)
}

const fed = (meta: TableMeta, sources: readonly Rated[]) =>
  sources.filter((s) => meta.feeds.some((f) => feeds(f, s)))

/** A stated licence without its "(where, read when)" note: "CC BY 4.0". */
const licenseName = (license: string) => license.replace(/\s*\(.*\)\s*$/, '')

/** "a", "a and b", "a, b, and c". */
const series = (parts: readonly string[]) =>
  parts.length < 3 ? parts.join(' and ') : `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`

function tableLicensing(meta: TableMeta, sources: readonly Rated[]): DictionaryTable['licensing'] {
  if (meta.feeds.includes('own')) {
    return {
      commercial: 'yes',
      note: `Yes. These are records of our own checks. ${OURS_TERMS}`,
      ours: [],
      restricted: [],
      upstream: [],
      not_cleared: [],
    }
  }
  const from = fed(meta, sources)
  const ours = from.filter((s) => s.rights === 'ours').map((s) => s.id)
  const restricted = from.filter((s) => s.rights === 'restricted').map((s) => s.id)
  const upstream = from
    .filter((s) => s.rights === 'upstream')
    .map((s) => ({ id: s.id, license: s.license }))
  const notCleared = from
    .filter((s) => s.rights === 'not-cleared' || s.rights === null)
    .map((s) => s.id)
  const lists = { ours, restricted, upstream, not_cleared: notCleared }
  const kinds = [ours, restricted, upstream, notCleared].filter((l) => l.length > 0).length
  const licenses = [
    ...new Set(upstream.flatMap((u) => (u.license ? [licenseName(u.license)] : []))),
  ]
  const upstreamTerms = licenses.length ? ` (${licenses.join('; ')})` : ''
  if (kinds === 1 && ours.length) {
    return { commercial: 'yes', note: RIGHTS_ANSWER.ours, ...lists }
  }
  if (kinds === 1 && restricted.length) {
    return { commercial: 'restricted', note: RIGHTS_ANSWER.restricted, ...lists }
  }
  if (kinds === 1 && notCleared.length) {
    return { commercial: 'no', note: RIGHTS_ANSWER['not-cleared'], ...lists }
  }
  if (kinds === 1) {
    return {
      commercial: 'upstream',
      note: `Under each source’s own license${upstreamTerms}.`,
      ...lists,
    }
  }
  const one = (n: number, singular: string, many: string) => `${n} ${n === 1 ? singular : many}`
  const parts = [
    ours.length ? one(ours.length, 'is ours to license', 'are ours to license') : null,
    restricted.length
      ? one(
          restricted.length,
          'is licensable with a terms restriction we disclose',
          'are licensable with a terms restriction we disclose',
        )
      : null,
    upstream.length
      ? `${one(upstream.length, 'passes', 'pass')} on under upstream terms${upstreamTerms}`
      : null,
    notCleared.length
      ? one(notCleared.length, 'isn’t covered by our license', 'aren’t covered by our license')
      : null,
  ].filter((p): p is string => p !== null)
  return {
    commercial: 'mixed',
    note: [
      `It depends on the source. Of the sources it reads, ${series(parts)}.`,
      restricted.length
        ? 'Our license covers what comes from sources that are ours, and our compilation of the restricted ones.'
        : 'Our license covers only what comes from sources that are ours.',
      meta.licenseNote,
    ]
      .filter(Boolean)
      .join(' '),
    ...lists,
  }
}

// ---- assembly -----------------------------------------------------------------

function asOfOf(table: ExportTable): DictionaryTable['as_of'] {
  if (table.pointInTime === 'refused') {
    const reason = table.asOfRefusal ?? ''
    return {
      mode: 'refused',
      note: `as_of answers 400 for this table. ${reason.charAt(0).toUpperCase()}${reason.slice(1)}`,
    }
  }
  if (table.pointInTime === 'rebuilt') return { mode: 'rebuilt', note: REBUILT_NOTE }
  return { mode: 'cut', note: AS_OF_CUT[table.name] ?? '' }
}

function historyOf(table: ExportTable): Omit<DictionaryTable['history'], 'start'> {
  const rule = historyRule(table.name)
  if (rule.kind === 'whole') {
    return {
      mode: 'whole',
      dated: [],
      full: null,
      note: `Downloads whole, since ${rule.why}`,
    }
  }
  return {
    mode: 'windowed',
    dated: [...rule.dated],
    full: `/export/${table.name}.csv?${HISTORY_PARAM}=full`,
    note: `Downloads the last ${LICENSE_WINDOW_DAYS} days by default, dated by ${rule.basis}. Add ?${HISTORY_PARAM}=full for every row.`,
  }
}

function dictionaryTable(table: ExportTable, sources: readonly Rated[]): DictionaryTable {
  const meta = TABLE_META[table.name]
  if (!meta) throw new Error(`no table facts for export ${table.name}`)
  const columns = asOfColumns(table).map((name): DictionaryColumn => {
    const c = name === AS_OF_VERIFIED ? AS_OF_VERIFIED_DOC : table.docs[name]!
    return {
      name,
      type: c.type,
      meaning: c.meaning,
      unit: c.unit ?? null,
      nullable: c.nullable === true,
      role: c.key ? 'key' : c.provenance ? 'provenance' : null,
      as_of_only: !table.columns.includes(name),
    }
  })
  return {
    name: table.name,
    description: table.description,
    csv: `/export/${table.name}.csv`,
    json: `/export/${table.name}.json`,
    key: columns.filter((c) => c.role === 'key').map((c) => c.name),
    grain: meta.grain,
    cadence: meta.cadence,
    time: { event: meta.event, knowledge: meta.knowledge },
    as_of: asOfOf(table),
    history: { ...historyOf(table), start: meta.start },
    joins: [...meta.joins],
    licensing: tableLicensing(meta, sources),
    columns,
  }
}

/**
 * The whole dictionary, in export order. Pure: no database, so it can never
 * be half-true. Licensing is read from `sourcesYaml`'s rights, never retyped.
 */
export function dataDictionary(sourcesYaml: string): DataDictionary {
  const sources = ratedSources(sourcesYaml)
  return {
    schema_version: SCHEMA_VERSION,
    types: { ...DATA_TYPES },
    provenance: PROVENANCE_NOTE,
    license: LICENSE_NOTE,
    time: TIME_NOTE,
    joining: JOINING_NOTE,
    tables: Object.values(EXPORT_TABLES).map((t) => dictionaryTable(t, sources)),
    sources: sources.map((s) => ({
      id: s.id,
      group: s.group,
      rights: s.rights,
      license: s.license,
      commercial: sourceAnswer(s),
    })),
    changelog: schemaChangelog(),
  }
}

export const DICTIONARY_CSV_COLUMNS = [
  'table',
  'column',
  'type',
  'unit',
  'nullable',
  'role',
  'as_of_only',
  'meaning',
  'table_as_of',
  'table_history',
] as const

/** One CSV row per table and column, in export order. */
export function dictionaryCsv(dictionary: DataDictionary): string {
  return [
    csvLine(DICTIONARY_CSV_COLUMNS),
    ...dictionary.tables.flatMap((t) =>
      t.columns.map((c) =>
        csvLine([
          t.name,
          c.name,
          c.type,
          c.unit,
          c.nullable,
          c.role,
          c.as_of_only,
          c.meaning,
          t.as_of.mode,
          t.history.mode,
        ]),
      ),
    ),
  ].join('')
}
