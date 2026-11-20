import type { ArchiveReach, LabId, Prov, ProviderId, Stamp } from './common'
import type { SnapshotStamp } from './coverage'
import type { FieldDiff } from './alerts'

export interface PriceDeltaView extends Prov {
  change_type: 'added' | 'removed' | 'modified'
  detected_at: string
  input_before: number | null
  input_after: number | null
  output_before: number | null
  output_after: number | null
  cached_before: number | null
  cached_after: number | null
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
  context_window_source: (Prov & { source_id: string; checked_at: string | null }) | null
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
  /**
   * The newest read of `source_id` that still showed this row, when later
   * than `fetched_at` (which only moves when the row changes); null for a
   * delisted row or a source that has not been re-read since.
   */
  checked_at: string | null
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
  /** fetched_at of the newest poll of `basis_source_id` that confirmed `basis_current`. */
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
