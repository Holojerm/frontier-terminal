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

export type ProviderId = 'openai' | 'anthropic' | 'google' | 'xai' | 'other'
export type BigFour = Exclude<ProviderId, 'other'>

export type SourceAxis =
  | 'pricing-catalog'
  | 'pricing-cross-check'
  | 'hiring'
  | 'sec'
  | 'revenue'
  | 'status'
  | 'demand-share'
export type SourceRole = 'primary' | 'join' | 'cross-check' | 'sec' | 'status'
export type RunStatus = 'ok' | 'unchanged' | 'failed' | 'baseline' | 'skipped'

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
  /** The audited URL this source is fetched from. */
  url: string
  newest_snapshot: SnapshotStamp | null
  snapshot_count: number
  last_run: SourceRunStamp | null
  /** Rows in the current entity set that came from this source. */
  entity_count: number
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
  rows: number
}

export interface CutSource {
  id: string
  verdict: string
  reason: string
}

export interface CoverageData extends Stamp {
  sources: SourceCoverage[]
  /** Deliberate cuts from sources.yaml — what is NOT tracked, and why. */
  cuts: CutSource[]
  totals: TableCounts
  exports: ExportTableInfo[]
  /** Newest fetch across every source. */
  latest_fetched_at: string | null
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
  recent: { pricing: number; hiring: number; sec: number; incidents: number; total: number }
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
  /** Newest ticker-tier rows first (info) — what moved, low stakes. */
  ticker: AlertView[]
  ticker_count: number
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
  provider: BigFour
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
  providers: BigFour[]
  cells: MatrixCell[]
  /** Which tier the matrix reads — stated in the UI. */
  tier_note: string
}

export interface PricesData extends Stamp {
  rows: PriceRowView[]
  matrix: PriceMatrix
  counts: { total: number; priced: number; catalog_only: number; removed: number }
  changes_available: boolean
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
  kind: 'baseline' | 'added' | 'modified' | 'removed' | 'current'
  source_id: string
  input_per_mtok: number | null
  cached_input_per_mtok: number | null
  output_per_mtok: number | null
  /** Scalar fields that differ from the previous revision (modified points only). */
  diff: FieldDiff[]
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
  provider: BigFour
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
  provider: BigFour
  incident_id: string
  title: string
  /** Vendor vocabulary, verbatim: Statuspage none/minor/major/critical; Google low/medium/high. */
  impact: string
  status: string
  started_at: string
  /** null while the incident is open. */
  resolved_at: string | null
  /** Statuspage component names / Google affected_products titles. */
  components: string[]
  incident_url: string
}

export interface IncidentProviderView {
  provider: BigFour
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
  provider: BigFour
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
  tag: string
  val: number
  /** SEC's calendar frame when the fact is the canonical one for it (CY2026Q2). */
  frame: string | null
}

export interface RevenueFilerView {
  ticker: string
  cik: string
  /** As the filer's company-facts payload names itself. */
  entity_name: string | null
  /** issuer: the lab files for itself. parent: a public parent consolidates it, and the series is the parent's. */
  relation: 'issuer' | 'parent'
  source_id: string
  /** The audit's caveat for the feed — for a parent, the words that say whose revenue this is. */
  caveat: string | null
}

export interface RevenueProviderView {
  provider: BigFour
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
  provider: BigFour
  display: string
  tokens: number
  /** Tokens on models that matched a priced SKU. */
  priced_tokens: number
  /** priced_tokens / tokens; null when the lab routed nothing in the window. */
  coverage: number | null
  spend_low: number
  spend_high: number
  /** This lab's spend_low over the four labs' spend_low, 0..1; null when nothing is priced. */
  share_low: number | null
  share_high: number | null
  /** Token share of the same window, for the decomposition: tokens vs. dollars. */
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
    /** Tokens routed to models outside the four labs — not priced here, stated as the gap. */
    other_tokens: number
    priced_tokens: number
    spend_low: number
    spend_high: number
  }
  /** Labs with tokens in the window but no priced SKU matched: in the token share, out of the dollar share, and said so. */
  excluded: { provider: BigFour; display: string; reason: string }[]
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
 * from the current entity set (server/utils/terminal-history.ts). The
 * series starts at the provider's earliest snapshot; roles that opened or
 * closed between the last imported poll and this store's baseline are not
 * in the log and are carried as they stand today.
 */
export interface HiringHistoryProvider {
  provider: BigFour
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
}

export interface HiringHistoryData extends Stamp {
  window_days: number
  providers: HiringHistoryProvider[]
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
  entity_type: 'job' | 'model' | 'filing' | 'incident' | 'ranking' | 'revenue' | 'recommendation'
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
  rule: 'agent-judge' | 's1-floor' | 'periodic-floor'
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
