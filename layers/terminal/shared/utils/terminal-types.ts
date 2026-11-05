// Response shapes for the terminal API (server/api/* -> app/pages/*).
//
// Every displayed datum descends from a type carrying Prov: provenance
// (source_url + fetched_at) is a field of the data, not a UI garnish. The
// shapes are plain JSON so a KV cache can hold them and a page can render
// them without a second conversion.

import type { AlertSeverity, AlertTierFilter } from './terminal-tiers'

export interface Prov {
  source_url: string
  /** ISO 8601 with timezone, exactly as stored. */
  fetched_at: string
}

export type ProviderId =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'xai'
  | 'meta'
  | 'mistral'
  | 'deepseek'
  | 'alibaba'
  | 'moonshot'
  | 'other'
export type LabId = Exclude<ProviderId, 'other'>

export type SourceAxis =
  | 'pricing-catalog'
  | 'pricing-cross-check'
  | 'hiring'
  | 'sec'
  | 'revenue'
  | 'status'
  | 'disclosures'
  | 'demand-share'
export type SourceRole = 'primary' | 'join' | 'cross-check' | 'sec' | 'status'
/**
 * What a paid licence could cover, per sources.yaml `rights:`. `ours`: facts
 * the publisher states about itself, read under terms and a robots.txt that
 * allow it, so the compilation is ours to license. `upstream`: someone else's
 * dataset under its own licence (CC BY and the like), which travels with it.
 * `not-cleared`: no stated licence, unread terms, or a robots/terms
 * restriction, so it stays on the free site and out of any paid offer.
 */
export const SOURCE_RIGHTS = ['ours', 'upstream', 'not-cleared'] as const
export type SourceRights = (typeof SOURCE_RIGHTS)[number]
export type RunStatus = 'ok' | 'unchanged' | 'failed' | 'baseline' | 'skipped' | 'absent'

/** Where the numbers on a page stand in time. Every payload carries one. */
export interface Stamp {
  /** Newest source_runs.started_at — the poll tick this data reflects; null before the first tick. */
  as_of: string | null
  /** When this payload was computed (it may then sit in the cache for up to five minutes). */
  computed_at: string
}

// ---- coverage --------------------------------------------------------------

export interface SnapshotStamp extends Prov {
  http_status: number | null
  bytes: number | null
}

export interface SourceRunStamp {
  started_at: string
  status: RunStatus
  detail: string | null
  scope: string
  /**
   * The url this run actually fetched. Usually the same as the newest
   * snapshot's, and the only record of it when the run produced no snapshot
   * — a 404 is fetched and stored nowhere else.
   */
  source_url: string
}

/** One registered source, whether or not it has ever been fetched. */
export interface SourceCoverage {
  source_id: string
  label: string
  provider: ProviderId | 'all'
  axis: SourceAxis
  role: SourceRole
  /** The audit's own words, read from sources.yaml — never paraphrased here. */
  caveat: string | null
  /**
   * The licence the source itself states, verbatim from sources.yaml. Null
   * where it states none, which is most of them — a pricing page publishes
   * facts without publishing terms, and inventing terms on its behalf would be
   * exactly the kind of claim the provenance rule exists to prevent.
   */
  license: string | null
  /**
   * The audit's reading of the source's terms and robots.txt, what is taken
   * and how often, verbatim from sources.yaml. A derived source carries the
   * entry of the registered source its template belongs to.
   */
  terms: string | null
  rights: SourceRights | null
  /** The audited URL this source is fetched from. */
  url: string
  newest_snapshot: SnapshotStamp | null
  snapshot_count: number
  last_run: SourceRunStamp | null
  /** Rows in the current entity set that came from this source. */
  entity_count: number
  /** Set for a source the store derived for itself (sources.yaml derived_sources): the template id. */
  derived_from: string | null
}

export interface TableCounts {
  snapshots: number
  entities: number
  changes: number
  alerts: number
  source_runs: number
}

export interface ExportTableInfo {
  name: string
  description: string
  columns: string[]
  /** Whole table. Windowed tables count every row, though the default download is the license window. */
  rows: number
  /** windowed: the default download is the trailing license window; whole: every row. */
  history: 'windowed' | 'whole'
}

/** A column's value type in both export formats (DATA_TYPES says what each means). */
export type DictionaryType =
  | 'text'
  | 'integer'
  | 'number'
  | 'timestamp'
  | 'date'
  | 'json'
  | 'boolean'

/** One exported column, as /export/dictionary.json documents it. */
export interface DictionaryColumn {
  name: string
  type: DictionaryType
  /** What the column holds, in one sentence. */
  meaning: string
  unit: string | null
  nullable: boolean
  /** key: part of the row's unique key. provenance: where and when the row was read. */
  role: 'key' | 'provenance' | null
  /** Present only when the table is requested with ?as_of=. */
  as_of_only: boolean
}

export interface DictionaryTable {
  name: string
  description: string
  csv: string
  json: string
  /** The columns that identify a row, in order. */
  key: string[]
  /** One row per what. */
  grain: string
  /** How often rows are added or rewritten. */
  cadence: string
  /** event: the column dating what the row describes (null for a bare observation). knowledge: when the row first existed for us. */
  time: { event: string | null; knowledge: string }
  as_of: { mode: 'cut' | 'rebuilt' | 'refused'; note: string }
  /**
   * How the license window cuts the default download: windowed tables serve
   * the rows `dated` on or after its first day (?history=full serves all),
   * whole tables every row. `start` says where the history begins.
   */
  history: {
    mode: 'windowed' | 'whole'
    dated: string[]
    full: string | null
    note: string
    start: string
  }
  /** The identifier columns to join on, and what each joins to. */
  joins: DictionaryJoin[]
  /** Whether a licensee can use the rows commercially, from each feeding source's sources.yaml rights. */
  licensing: {
    commercial: 'yes' | 'upstream' | 'no' | 'mixed'
    note: string
    ours: string[]
    upstream: { id: string; license: string | null }[]
    not_cleared: string[]
  }
  columns: DictionaryColumn[]
}

export interface DictionaryJoin {
  column: string
  /** `table.column`, or `your security master` for an identifier to match outside the site. */
  to: string
}

/** One source's commercial-use answer, from its sources.yaml rights. */
export interface SourceLicensing {
  id: string
  /** The sources.yaml block it's in. */
  group: 'sources' | 'recipes' | 'track_record' | 'archive' | 'filed_facts' | 'identifiers'
  rights: SourceRights | null
  /** The licence the source states, verbatim, or null. */
  license: string | null
  commercial: string
}

export interface DataDictionary {
  /** The export schema's version (layers/terminal/server/utils/data-schema.ts). */
  schema_version: string
  types: Record<DictionaryType, string>
  provenance: string
  /** The license split, and the license column a full-history download adds. */
  license: string
  /** What event time and knowledge time mean. */
  time: string
  /** How to join the tables to a security master. */
  joining: string
  tables: DictionaryTable[]
  /** Every source sources.yaml rates, with its commercial-use answer. */
  sources: SourceLicensing[]
  /** Every schema release, newest first. */
  changelog: SchemaChangelogEntry[]
}

/** One release of the export schema: what it added, removed, or renamed, per table. */
export interface SchemaChangelogEntry {
  version: string
  /** UTC day the release reached /export. */
  date: string
  summary: string
  tables: {
    name: string
    added: string[]
    removed: string[]
    renamed: { from: string; to: string }[]
    note: string | null
  }[]
}

export interface CutSource {
  id: string
  verdict: string
  reason: string
}

/** One thesis recipe (layers/terminal/server/theses/recipes/): how its last run ended and what it has stored. */
export interface TrackRecordSource {
  id: string
  url: string | null
  terms: string | null
  rights: SourceRights | null
  caveat: string | null
}

export interface RecipeCoverage {
  recipe_id: string
  company: string
  description: string
  /** The URL the last run fetched; the recipe's own URL before any run. */
  url: string
  last_run: {
    status: 'ok' | 'unchanged' | 'failed' | 'skipped'
    started_at: string
    detail: string | null
  } | null
  observations: number
  /** Newest stored observation's fetch. */
  newest: Prov | null
  /** The audit's words from sources.yaml recipe_sources; null only for a recipe with no entry, which a test forbids. */
  caveat: string | null
  terms: string | null
  rights: SourceRights | null
}

export interface CoverageData extends Stamp {
  sources: SourceCoverage[]
  /** Deliberate cuts from sources.yaml — what is NOT tracked, and why. */
  cuts: CutSource[]
  /** The thesis recipes, which store outside the lab tables. */
  recipes: RecipeCoverage[]
  /** Sources the track record queries per alert (GDELT), with their audit entry. */
  track_record: TrackRecordSource[]
  totals: TableCounts
  exports: ExportTableInfo[]
  /** Newest fetch across every source. */
  latest_fetched_at: string | null
  /** Oldest fetch on record: where every table's history starts. */
  first_fetched_at: string | null
}

// ---- overview / signal -----------------------------------------------------

/**
 * What moved. Counts come from the `changes` table, which is reproducible
 * from two snapshots — never from a re-read of the current state.
 */
export interface MovementSummary {
  /** Newest detected_at in the store; null when nothing has ever diffed. */
  latest_detected_at: string | null
  /** Start of the reported window: window_hours back from latest_detected_at. */
  window_from: string | null
  window_hours: number
  /** Changes inside that window, by axis. */
  recent: {
    pricing: number
    hiring: number
    sec: number
    incidents: number
    disclosures: number
    total: number
  }
  /** Every change ever recorded — the denominator for "quiet" claims. */
  total_changes: number
  /** Sources with snapshots at all. */
  sources_total: number
  /** Sources whose newest snapshot is the only one they have: nothing to diff yet. */
  sources_not_yet_compared: number
}

export interface OverviewData extends Stamp {
  movement: MovementSummary
  /** Newest alert-tier rows first (notable, critical), with their cited change rows. */
  alerts: AlertView[]
  alert_count: number
  /** Newest minor changes first (severity info) — what moved, low stakes. */
  info: AlertView[]
  info_count: number
  totals: TableCounts
  latest_fetched_at: string | null
}

// ---- prices ----------------------------------------------------------------

export interface PriceDeltaView extends Prov {
  change_type: 'added' | 'removed' | 'modified'
  detected_at: string
  input_before: number | null
  input_after: number | null
  output_before: number | null
  output_after: number | null
}

export interface PriceRowView extends Prov {
  entity_key: string
  source_id: string
  provider: ProviderId
  model_slug: string
  tier: string | null
  context_window: string | null
  /**
   * Set when context_window is not printed by the row's own source: the
   * stored row of the same model it was read from (a Google model page
   * prints the window its pricing page omits, for every tier).
   */
  context_window_source: (Prov & { source_id: string }) | null
  input_per_mtok: number | null
  cached_input_per_mtok: number | null
  output_per_mtok: number | null
  effective_from: string | null
  effective_until: string | null
  notes: string | null
  /** True when the newest change for this key is a removal and no current row exists. */
  removed: boolean
  delta: PriceDeltaView | null
  /** Other sources carrying the same SKU key (the two Anthropic pages both do). */
  also_listed_by: string[]
  /** Observations of this SKU on record — change rows plus the current row (see PriceHistoryData). */
  revisions: number
  /** One price field across those observations, oldest first; null until there are two. */
  spark: { field: 'input_per_mtok' | 'output_per_mtok'; values: (number | null)[] } | null
}

export type ModelClassId = 'flagship' | 'balanced' | 'economy'

export interface ClassColumn {
  id: ModelClassId
  label: string
  /** The question the column asks, so the mapping rule is visible. */
  question: string
}

/**
 * One provider's answer in one class. `row` is a real stored price row with
 * its own provenance; `basis` is the vendor sentence that justifies the
 * mapping; `gap` explains an empty cell instead of leaving it blank.
 */
export interface MatrixCell {
  provider: LabId
  class: ModelClassId
  row: PriceRowView | null
  basis: string | null
  basis_source_id: string | null
  /**
   * Whether `basis` was found on the vendor page at the last poll of
   * `basis_source_id`; null when that page has not been polled since the
   * check was introduced, or the cell is unmapped.
   */
  basis_current: boolean | null
  /** fetched_at of the poll that produced `basis_current`. */
  basis_checked_at: string | null
  /** Set when basis_current is false: what the reader should make of the cell. */
  basis_note: string | null
  /** Set when there is no price to show: why, in the vendor's terms. */
  gap: string | null
  /** true => a stored row with at least one published $/Mtok figure. */
  priced: boolean
}

export interface PriceMatrix {
  classes: ClassColumn[]
  providers: LabId[]
  cells: MatrixCell[]
  /** Which tier the matrix reads — stated in the UI. */
  tier_note: string
}

export interface PricesData extends Stamp {
  rows: PriceRowView[]
  matrix: PriceMatrix
  counts: { total: number; priced: number; catalog_only: number; removed: number }
  changes_available: boolean
  /** How far back price history reaches per lab, archived and live. */
  reach: PriceReach[]
  /** OpenRouter: snapshotted for drift checks, never rendered as a price. */
  cross_check: {
    source_id: string
    label: string
    caveat: string | null
    snapshot: SnapshotStamp
  } | null
}

/**
 * One observation of a SKU: a change row (added / modified / removed), the
 * current entity row, or — when the earliest change carries a before state
 * — that state as of the source's first snapshot ('baseline'). `at` is the
 * instant of the observation (detected_at for a change, fetched_at
 * otherwise) and the Prov fields say which fetch it was read from.
 */
export interface PricePoint extends Prov {
  at: string
  /**
   * 'archived': read from the Internet Archive's capture of the lab's own page
   * (archived_prices), before this site watched it. `at` is the capture time,
   * source_url the Wayback capture, fetched_at when we read the capture back.
   */
  kind: 'archived' | 'baseline' | 'added' | 'modified' | 'removed' | 'current'
  /** 'archived' on an Internet Archive point; 'live' on every point this site observed. */
  basis: 'archived' | 'live'
  source_id: string
  input_per_mtok: number | null
  cached_input_per_mtok: number | null
  output_per_mtok: number | null
  /** Scalar fields that differ from the previous revision (modified points only). */
  diff: FieldDiff[]
}

/**
 * How far one lab's history reaches on one axis (prices, or hiring).
 * archived_from is the earliest Internet Archive capture we could read;
 * live_from the first time this site fetched the lab's own page or board.
 * Either is null when there is none.
 */
export type PriceReach = ArchiveReach

export interface ArchiveReach {
  provider: LabId
  archived_from: string | null
  archived_until: string | null
  /** Captures read and stored, and captures skipped because they could not be read confidently. */
  archived_parsed: number
  archived_skipped: number
  live_from: string | null
  /** Stretches before live_from with no readable capture, and why. */
  gaps: { from: string; until: string; reason: string }[]
  /** Set when the lab's archived pages are not read at all. */
  not_covered: string | null
}

export interface PriceHistoryData extends Stamp {
  entity_key: string
  provider: ProviderId
  model_slug: string
  tier: string | null
  context_window: string | null
  /** Oldest first. */
  points: PricePoint[]
  /** True when the newest observation is a removal and no current row exists. */
  removed: boolean
  /** True when every point is archived: the SKU was gone (or renamed) before this site watched the page. */
  archive_only: boolean
}

// ---- hiring ----------------------------------------------------------------

export interface DeptCount {
  department: string
  count: number
}

/** A source cited beside a number: which feed, where, and when it was read. */
export interface SourceRef extends Prov {
  source_id: string
  label: string
}
export type HiringSource = SourceRef

export interface HiringProviderView {
  provider: LabId
  display: string
  /** no_public_feed: an audited cut; no_rows: feed registered, nothing parsed yet. */
  feed: 'ok' | 'no_public_feed' | 'no_rows'
  /** Set for no_public_feed — the audit verdict, never a number. */
  reason: string | null
  total: number
  departments: DeptCount[]
  /** Travels with the data, e.g. the xAI SpaceXAI entity blend. */
  caveat: string | null
  /** Distinct company_name values observed on the rows — the blend evidence. */
  company_names: string[]
  sources: HiringSource[]
}

export interface HiringData extends Stamp {
  providers: HiringProviderView[]
}

// ---- incidents (capacity strain) -------------------------------------------

/** One posted incident, as the vendor's own feed states it. */
export interface IncidentView extends Prov {
  entity_key: string
  source_id: string
  provider: LabId
  incident_id: string
  title: string
  /** Vendor vocabulary, verbatim: Statuspage none/minor/major/critical; Google low/medium/high.
   * null where the feed publishes none (Anthropic's Atom history): never inferred. */
  impact: string | null
  status: string
  started_at: string
  /** null while the incident is open. */
  resolved_at: string | null
  /** Statuspage component names / Google affected_products titles. */
  components: string[]
  incident_url: string
}

export interface IncidentProviderView {
  provider: LabId
  display: string
  /** no_public_feed: an audited cut; no_rows: feed registered, nothing parsed yet. */
  feed: 'ok' | 'no_public_feed' | 'no_rows'
  /** Set for no_public_feed — the audit verdict, never a number. */
  reason: string | null
  /** The audit's caveat for the feed (e.g. Google's product filter), in its own words. */
  caveat: string | null
  /** Incidents started inside the newest window_days. */
  last_window: number
  /** Incidents started in the window_days before that. */
  prior_window: number
  /** Currently open (resolved_at null), newest first. */
  open: IncidentView[]
  /** Earliest started_at held for this provider — where the count's history begins. */
  coverage_from: string | null
  sources: SourceRef[]
}

export interface IncidentsData extends Stamp {
  /** The windows count back from here: the newest status-feed fetch, or computed_at before any. */
  window_to: string
  window_days: number
  history_days: number
  providers: IncidentProviderView[]
  /** Every incident started inside history_days, all providers, newest first. */
  incidents: IncidentView[]
}

// ---- disclosures (misalignment) --------------------------------------------

/**
 * The dates on one report's own page. `lines` is the page's metadata cell,
 * verbatim; the two dates below are read out of it and never inferred.
 */
export interface DisclosureTimeline extends Prov {
  lines: { label: string; value: string }[]
  discovered_on: string | null
  /** The publication date the lag is measured to. */
  disclosed_on: string | null
  /**
   * printed: the page's own "Disclosure date" line. first_listed: the
   * earliest date the index has shown beside the entry, across every
   * observation this store holds. null when there is no date at all.
   */
  disclosed_basis: 'printed' | 'first_listed' | null
  /** Calendar days from discovered_on to disclosed_on; null when either is missing. */
  days_to_disclosure: number | null
}

/** One entry on a lab's own disclosure index, in the lab's own words. */
export interface DisclosureView extends Prov {
  entity_key: string
  provider: LabId
  kind: 'report' | 'notice'
  entry_id: string
  title: string
  summary: string
  model: string | null
  observed_during: string | null
  /** The date the index prints beside the entry as of the newest fetch (it moves on revision). */
  listed_on: string
  entry_url: string
  /**
   * not_applicable: a notice (its page is off-site). not_fetched: the
   * report's page has not been polled yet. title_mismatch: the page fetched
   * for this slug carries a different title, so its dates are not attached.
   */
  timeline_status: 'ok' | 'not_applicable' | 'not_fetched' | 'title_mismatch'
  timeline: DisclosureTimeline | null
}

export interface DisclosureProviderView {
  provider: LabId
  display: string
  /** no_public_feed: an audited cut (no disclosure index); no_rows: registered, nothing parsed yet. */
  feed: 'ok' | 'no_public_feed' | 'no_rows'
  /** Set for no_public_feed — the audit verdict, never a number. */
  reason: string | null
  caveat: string | null
  reports: number
  notices: number
  /** Median of days_to_disclosure over the reports that have one. */
  median_days_to_disclosure: number | null
  /** How many reports that median is taken over. */
  timed_reports: number
  sources: SourceRef[]
}

export interface DisclosuresData extends Stamp {
  providers: DisclosureProviderView[]
  /** Every entry held, newest listed first. */
  entries: DisclosureView[]
}

// ---- demand share (OpenRouter usage rankings) ------------------------------

export interface ProviderShare {
  provider: ProviderId
  display: string
  /** Tokens routed in the share window. */
  tokens: number
  /** 0..1 of the window's total across every provider; null when the window is empty. */
  share: number | null
  prior_tokens: number
  prior_share: number | null
  /** share minus prior_share, in percentage points; null when either side is missing. */
  delta_pp: number | null
}

export interface TopModel extends Prov {
  provider: ProviderId
  model_permaslug: string
  /** Tokens in the share window. */
  tokens: number
  /** 0..1 of the provider's own window tokens. */
  share_of_provider: number | null
}

export interface ProviderTopModels {
  provider: LabId
  display: string
  models: TopModel[]
}

export interface RankingDay {
  date: string
  tokens: Record<ProviderId, number>
  total: number
}

export interface DateWindow {
  from: string
  to: string
}

export interface RankingsCoverage {
  /** Distinct UTC days in the store. */
  days: number
  first_date: string | null
  last_date: string | null
  /** The newest SHARE_WINDOW_DAYS days present, and the SHARE_WINDOW_DAYS before them. */
  window: DateWindow | null
  prior_window: DateWindow | null
}

export interface RankingsData extends Stamp {
  /** ok: rows exist. not_configured: the newest run was skipped for want of the key. no_rows: registered, nothing parsed yet. */
  status: 'ok' | 'not_configured' | 'no_rows'
  source: {
    source_id: string
    label: string
    url: string
    caveat: string | null
    license: string | null
    last_run: SourceRunStamp | null
    newest_snapshot: SnapshotStamp | null
  }
  /** The newest fetch of the feed — null only before the first successful fetch. */
  provenance: Prov | null
  meta: {
    /** OpenRouter's meta.as_of for the newest parsed payload. */
    as_of: string | null
    /** The required CC BY 4.0 citation, as_of filled in. */
    citation: string | null
    coverage: RankingsCoverage
  }
  shares: ProviderShare[]
  top_models: ProviderTopModels[]
  series: RankingDay[]
}

// ---- revenue (disclosed, primary-source only) -------------------------------

/**
 * One reported period: the filer's own XBRL value for one revenue tag over
 * start..end, from the filing that reported it. When a later filing
 * restates the same period, `superseded_by` names it and the newest
 * filing's value is the one the period table shows.
 */
export interface RevenuePeriod extends Prov {
  entity_key: string
  start: string
  end: string
  /** Calendar days in the period — ~91 reads as a quarter, ~182 a half, ~365 a year. */
  days: number
  fy: number | null
  fp: string | null
  form: string
  filed: string
  accession_no: string
  /** EDGAR's filing index for the accession — composed from cik + accession, verified to resolve. */
  filing_url: string
  /** The XBRL tag, or for a prospectus value the statement's own row label. */
  tag: string
  val: number
  /** SEC's calendar frame when the fact is the canonical one for it (CY2026Q2). */
  frame: string | null
  /** xbrl: tagged data. prospectus: read off the statement printed in a registration filing that tags no financials. */
  basis: 'xbrl' | 'prospectus'
  /** An interim period from a registration statement, which prints it unaudited. */
  unaudited: boolean
}

export interface RevenueFilerView {
  /** The ticker sources.yaml tags; null for a filer resolved from its own S-1 (no ticker until it lists). */
  ticker: string | null
  cik: string
  /** As the filer's company-facts payload names itself. */
  entity_name: string | null
  /** issuer: the lab files for itself. parent: a public parent consolidates it, and the series is the parent's. */
  relation: 'issuer' | 'parent'
  /** The parent's segment member the series is read on (goog:GoogleCloudMember); null for a consolidated series. */
  segment: string | null
  /** The segment as a reader names it (Google Cloud); null with `segment`. */
  segment_label: string | null
  /** How the filer was tagged: the audited file, or resolved at poll time from a registration filing (pending_filers). */
  tagged_by: 'sources.yaml' | 'resolved'
  /** For a resolved filer: the filing the CIK was read from. */
  resolved_from: {
    form: string
    accession_no: string
    file_date: string
    filing_url: string
  } | null
  source_id: string
  /** The audit's caveat for the feed — for a parent, the words that say whose revenue this is. */
  caveat: string | null
}

export interface RevenueProviderView {
  provider: LabId
  display: string
  /** none: no audited disclosure on file, nothing shown. parent / issuer: a tagged filer with facts. no_rows: tagged, nothing parsed yet. */
  disclosure: 'none' | 'parent' | 'issuer' | 'no_rows'
  filer: RevenueFilerView | null
  /** Newest-period first; only the newest filing's value per (start, end). */
  periods: RevenuePeriod[]
  /** Periods dropped because a later filing restated them, newest first. */
  superseded: RevenuePeriod[]
  /** Tags present in the filer's facts, in preference order. */
  tags: string[]
  sources: SourceRef[]
}

export interface RevenueData extends Stamp {
  providers: RevenueProviderView[]
  /** The rule this panel obeys, stated once for the page. */
  rule: string
}

// ---- implied spend share (rankings × list prices) ---------------------------

/** One ranked model in the share window, joined to a stored SKU when one matched. */
export interface SpendModel {
  model_permaslug: string
  tokens: number
  /** The SKU key the permaslug matched, or null — with `reason` saying why not. */
  matched_key: string | null
  /** free: an OpenRouter free-tier variant; unlisted: no stored SKU with that slug; unpriced: SKU listed without a published price. */
  reason: 'free' | 'unlisted' | 'unpriced' | null
  input_per_mtok: number | null
  output_per_mtok: number | null
  /** tokens × input list price, in USD; the floor of what those tokens would cost at list. */
  spend_low: number | null
  /** tokens × output list price, in USD; the ceiling. */
  spend_high: number | null
  price_source_url: string | null
  price_fetched_at: string | null
}

export interface SpendProviderView {
  provider: LabId
  display: string
  tokens: number
  /** Tokens on models that matched a priced SKU. */
  priced_tokens: number
  /** priced_tokens / tokens; null when the lab routed nothing in the window. */
  coverage: number | null
  spend_low: number
  spend_high: number
  /** This lab's spend_low over the tracked labs' spend_low, 0..1; null when nothing is priced. */
  share_low: number | null
  share_high: number | null
  /** This lab's tokens over the tracked labs' tokens in the same window, for the decomposition:
   * tokens vs. dollars. Not the rankings' share, which is of all OpenRouter tokens. */
  token_share: number | null
  models: SpendModel[]
}

export interface SpendData extends Stamp {
  /** Mirrors RankingsData.status. */
  status: 'ok' | 'not_configured' | 'no_rows'
  window: DateWindow | null
  providers: SpendProviderView[]
  totals: {
    tokens: number
    /** Tokens routed to models outside the tracked labs — not priced here, stated as the gap. */
    other_tokens: number
    priced_tokens: number
    spend_low: number
    spend_high: number
  }
  /** Labs with tokens in the window but no priced SKU matched: in the token share, out of the dollar share, and said so. */
  excluded: { provider: LabId; display: string; reason: string }[]
  /** The rankings feed's provenance, citation and caveat travel with the derivation. */
  rankings: Pick<RankingsData, 'provenance' | 'source' | 'meta'>
  /** The pricing sources the SKUs came from. */
  price_sources: SourceRef[]
  /** What this number is and is not, stated once. */
  caveat: string
}

// ---- hiring history ---------------------------------------------------------

export interface DeptSeries {
  department: string
  /** Open roles at the end of each date in the provider's `dates`. */
  series: number[]
}

/**
 * One department cluster (sources.yaml `department_clusters`) on one board:
 * the departments whose names matched, and their summed open roles per day
 * on the provider's `dates`. `now`/`then` mirror HiringCompare's instant.
 */
export interface ClusterSeries {
  id: string
  label: string
  /** The board's own department labels that matched, largest today first — what was summed, visibly. */
  departments: DeptCompare[]
  series: number[]
  now: number
  /** null until the series has two points. */
  then: number | null
  /** The comparison instant, as HiringCompare.at. */
  then_at: string | null
}

export interface DeptCompare {
  department: string
  then: number
  now: number
}

/**
 * Open roles now against an earlier instant: `window_days` back, or the
 * start of the series when that is younger — `days` says which it was.
 */
export interface HiringCompare {
  at: string
  days: number
  total_then: number
  total_now: number
  departments: DeptCompare[]
}

/**
 * Open roles per day, reconstructed by undoing the change log backwards
 * from the current entity set (layers/terminal/server/utils/terminal-history.ts). The
 * series starts at the provider's earliest snapshot; roles that opened or
 * closed between the last imported poll and this store's baseline are not
 * in the log and are carried as they stand today.
 */
export interface HiringHistoryProvider {
  provider: LabId
  display: string
  feed: 'ok' | 'no_public_feed' | 'no_rows'
  reason: string | null
  caveat: string | null
  /** UTC dates (YYYY-MM-DD), oldest first; a point is the state at the end of that day. */
  dates: string[]
  total: number[]
  /** Every department seen in the window, largest today first. */
  departments: DeptSeries[]
  /** Named department clusters from sources.yaml (the physical-infrastructure buildout signal), summed over the matched departments. */
  clusters: ClusterSeries[]
  compare: HiringCompare | null
  /** Earliest snapshot of the provider's job board — where the series starts. */
  series_from: string | null
  /** This store's first (baseline) poll of the board; the log before it is imported history. */
  baseline_at: string | null
  /** Earliest snapshot of the board's /departments join, where one exists: rows before it carry no department. */
  join_from: string | null
  sources: HiringSource[]
  /** The Internet Archive's copies of the lab's board before we read it live, oldest first. */
  archived: ArchivedHiringPoint[]
  /** Where the archived board differs from the live one (another board, another entity mix). */
  archive_caveat: string | null
}

/**
 * One Internet Archive copy of a lab's job board, read into the counts the
 * live lane derives: `at` is when the Archive saw the board (event time);
 * fetched_at is when we read the copy back, long after (knowledge time).
 */
export interface ArchivedHiringPoint {
  at: string
  basis: 'archived'
  /** wayback:<era>, the board and window the copy belongs to (archive/hiring-eras.ts). */
  source_id: string
  /** Open roles on the whole board. */
  total: number
  /** Every department with its count, summing to total; null when the copy states only the total. */
  departments: ArchivedDepartmentCount[] | null
  /** sources.yaml department_clusters over each row's live department (`departments`: the labels printed); null with departments. */
  clusters: { id: string; label: string; open_roles: number; departments: string[] }[] | null
  source_url: string
  fetched_at: string
}

export interface ArchivedDepartmentCount {
  /** The live department it files under: the label, unless the board's own id ties it to a live one. */
  department: string
  /** As the board printed it then. */
  label: string
  open_roles: number
}

export interface HiringHistoryData extends Stamp {
  window_days: number
  providers: HiringHistoryProvider[]
  /** How far each lab's hiring history reaches: the Internet Archive backfill, then the live board. */
  reach: ArchiveReach[]
  /** What an archived point is, and event time against knowledge time. */
  archive_method: string
  /** The change rows the series rests on: how many, and the span they cover. */
  log: { changes: number; from: string | null; to: string | null }
}

// ---- releases --------------------------------------------------------------

/** A SKU first listed after a source's baseline: an `added` change on a model row. */
export interface ReleaseView extends Prov {
  change_id: string
  entity_key: string
  source_id: string
  provider: ProviderId
  model_slug: string
  tier: string | null
  context_window: string | null
  /** detected_at of the added change — when the listing was first seen. */
  first_seen_at: string
  input_per_mtok: number | null
  cached_input_per_mtok: number | null
  output_per_mtok: number | null
  notes: string | null
  /** Other sources that also listed the key (the two Anthropic pages both do). */
  also_listed_by: string[]
}

export interface ReleasesData extends Stamp {
  /** Newest first. */
  rows: ReleaseView[]
  /** Added rows dropped because they came from a source's first snapshot. */
  excluded_baseline: number
  /** Earliest snapshot in the store — before it, nothing could have been seen. */
  log_from: string | null
}

// ---- alerts ----------------------------------------------------------------

export interface FieldDiff {
  field: string
  before: string | null
  after: string | null
}

export interface ChangeView extends Prov {
  id: string
  entity_key: string
  entity_type:
    | 'job'
    | 'model'
    | 'filing'
    | 'incident'
    | 'ranking'
    | 'revenue'
    | 'recommendation'
    | 'filer'
    | 'disclosure'
    | 'disclosure_timeline'
    | 'document'
    | 'offering'
    | 'statement'
    | 'commitment'
    | 'concentration'
    | 'shares'
    | 'risk_factors'
  provider: ProviderId
  change_type: 'added' | 'removed' | 'modified'
  detected_at: string
  /** One line naming the entity, built only from fields in the row. */
  summary: string
  /** Scalar fields that differ between before_json and after_json. */
  diff: FieldDiff[]
}

export interface AlertView extends Prov {
  id: string
  severity: AlertSeverity
  headline: string
  explanation: string
  rule:
    | 'agent-judge'
    | 's1-floor'
    | 'periodic-floor'
    | 'cik-resolved'
    | 'model-floor'
    | 'prospectus-floor'
    | 'hiring-rollup'
  created_at: string
  change_ids: string[]
  /** The cited rows, resolved; ids that resolve to nothing are listed in `missing`. */
  changes: ChangeView[]
  missing_change_ids: string[]
}

export interface AlertsData extends Stamp {
  /** Which tier(s) `rows` and `total` cover. */
  tier: AlertTierFilter
  rows: AlertView[]
  total: number
}

/** A cited change on its permalink: every scalar field, before and after. */
export interface ChangeDetailView extends ChangeView {
  /** Every field of before_json ∪ after_json, sorted; unchanged ones included. */
  fields: FieldDiff[]
}

export interface AlertDetail extends Omit<AlertView, 'changes'> {
  changes: ChangeDetailView[]
}

export interface AlertDetailData extends Stamp {
  alert: AlertDetail
}

// ---- GPU rental prices --------------------------------------------------------

/** One published on-demand price, normalized to USD per GPU-hour (layers/terminal/server/theses/recipes/gpu-prices.ts). */
export interface GpuPriceView extends Prov {
  provider: string
  provider_name: string
  key: string
  gpu: 'H100' | 'B200'
  /** As printed: SXM, HGX, PCIe, NVL, or null when the page names none. */
  form_factor: string | null
  /** false for PCIe and NVL cards: kept, but not in the median. */
  counted: boolean
  label: string
  usd_per_gpu_hour: number
  gpus_per_instance: number | null
  instance_usd_per_hour: number | null
  region: string | null
  config: string | null
}

export interface GpuMedianView {
  gpu: 'H100' | 'B200'
  /** Median of the provider values; null with no provider priced. */
  median: number | null
  /** Each provider once, at the median of its own counted rows. */
  providers: (Prov & {
    provider: string
    provider_name: string
    usd_per_gpu_hour: number
    rows: number
  })[]
}

export interface GpuPricesData extends Stamp {
  medians: GpuMedianView[]
  prices: GpuPriceView[]
  /** Providers whose newest run failed: none of their prices count today. */
  failed: { provider: string; provider_name: string; detail: string }[]
  method: string
  caveat: string
}

// ---- track record ------------------------------------------------------------

/**
 * Where one side of an alert's track record stands. `matched` is the only
 * state with a time: everything else says why there is none.
 */
export type TrackRecordState =
  | 'window-open'
  | 'not-searched'
  | 'search-failed'
  | 'not-searchable'
  | 'no-feed'
  | 'none-found'
  | 'not-yet-rated'
  | 'no-match'
  | 'matched'

export interface TrackRecordHit {
  title: string
  outlet: string
  url: string
  /** When GDELT first saw the article, or the post's own publication time. */
  published_at: string
  /** The judge's same-event rationale. */
  rationale: string
  /** The GDELT query or newsroom feed the candidate came from, and when it was read. */
  source_url: string
  fetched_at: string
}

export interface TrackRecordSide {
  state: TrackRecordState
  /** The reason for `search-failed` or `not-searchable`. */
  detail: string | null
  hit: TrackRecordHit | null
  /** Hours from the saw-it time to the hit: positive when we saw it first. */
  lead_hours: number | null
  candidates: number
  rated: number
}

export interface TrackRecordRow {
  alert_id: string
  severity: AlertSeverity
  headline: string
  created_at: string
  providers: ProviderId[]
  /** When we saw it: the earliest cited change row (a removal counts from when we noticed it). */
  saw_at: string
  saw_source_url: string
  window_from: string
  window_to: string
  press: TrackRecordSide
  newsroom: TrackRecordSide
}

export interface TrackRecordTally {
  matched: number
  led: number
  lagged: number
  /** Same hour either way: |lead| under 0.05 h. */
  tied: number
  median_lead_hours: number | null
  not_yet_rated: number
}

export interface TrackRecordData extends Stamp {
  from: string
  window_days: number
  rows: TrackRecordRow[]
  press: TrackRecordTally
  newsroom: TrackRecordTally
  window_open: number
}
