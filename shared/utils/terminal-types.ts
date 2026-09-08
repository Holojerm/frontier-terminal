// Response shapes for the terminal API (server/api/* -> app/pages/*).
//
// Every displayed datum descends from a type carrying Prov: provenance
// (source_url + fetched_at) is a field of the data, not a UI garnish. The
// shapes are plain JSON so a KV cache can hold them and a page can render
// them without a second conversion.

export interface Prov {
  source_url: string
  /** ISO 8601 with timezone, exactly as stored. */
  fetched_at: string
}

export type ProviderId = 'openai' | 'anthropic' | 'google' | 'xai' | 'other'
export type BigFour = Exclude<ProviderId, 'other'>

export type SourceAxis = 'pricing-catalog' | 'pricing-cross-check' | 'hiring' | 'sec'
export type SourceRole = 'primary' | 'join' | 'cross-check' | 'sec'
export type RunStatus = 'ok' | 'unchanged' | 'failed' | 'baseline'

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
  recent: { pricing: number; hiring: number; sec: number; total: number }
  /** Every change ever recorded — the denominator for "quiet" claims. */
  total_changes: number
  /** Sources with snapshots at all. */
  sources_total: number
  /** Sources whose newest snapshot is the only one they have: nothing to diff yet. */
  sources_not_yet_compared: number
}

export interface OverviewData extends Stamp {
  movement: MovementSummary
  /** Newest alerts first, with their cited change rows. */
  alerts: AlertView[]
  alert_count: number
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

// ---- hiring ----------------------------------------------------------------

export interface DeptCount {
  department: string
  count: number
}

export interface HiringSource extends Prov {
  source_id: string
  label: string
}

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

// ---- alerts ----------------------------------------------------------------

export interface FieldDiff {
  field: string
  before: string | null
  after: string | null
}

export interface ChangeView extends Prov {
  id: string
  entity_key: string
  entity_type: 'job' | 'model' | 'filing'
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
  severity: 'info' | 'notable' | 'critical'
  headline: string
  explanation: string
  rule: 'agent-judge' | 's1-floor'
  created_at: string
  change_ids: string[]
  /** The cited rows, resolved; ids that resolve to nothing are listed in `missing`. */
  changes: ChangeView[]
  missing_change_ids: string[]
}

export interface AlertsData extends Stamp {
  rows: AlertView[]
  total: number
}
