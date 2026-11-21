import {
  modelKey,
  recommendationKey,
  type EntityRow,
  type PriceRow,
  type RecommendationRow,
} from '../../../core/server/pipeline/contracts'
import { collapse, toEntity } from '../../../core/server/pipeline/normalize'

// Normalize the price lists: validated price and drift-check rows ->
// EntityRow (boundary table, "normalize" = DETERMINISTIC).

// A scheduled price ("$Y starting Jan 1, 2027" — Google's promo strings) is
// its own SKU row beside the current one, with the same slug and tier. The
// contract says tier disambiguates promo windows, so the window's start date
// joins the tier here: the current row keeps the bare key, the scheduled row
// gets `<tier>@<effective_from>`. When the date arrives and the page drops
// the promo text, the diff reads as one modified row and one removed row.
export function priceTier(row: Pick<PriceRow, 'tier' | 'effective_from'>): string | null {
  if (!row.effective_from) return row.tier
  return `${row.tier ?? 'standard'}@${row.effective_from}`
}

export function normalizePrice(row: PriceRow, snapshotId: string): EntityRow {
  return toEntity(
    modelKey(row.provider, row.model_slug, priceTier(row)),
    'model',
    row.provider,
    snapshotId,
    row,
  )
}

export function normalizePrices(rows: readonly PriceRow[], snapshotId: string): EntityRow[] {
  return collapse(rows.map((row) => normalizePrice(row, snapshotId)))
}

// A recommendation row is one mapped matrix cell checked against the page it
// was transcribed from; `present` is part of the content, so the check
// flipping is a 'modified' change and an unchanged verdict diffs to nothing.
export function normalizeRecommendation(row: RecommendationRow, snapshotId: string): EntityRow {
  return toEntity(
    recommendationKey(row.provider, row.class),
    'recommendation',
    row.provider,
    snapshotId,
    row,
  )
}

export function normalizeRecommendations(
  rows: readonly RecommendationRow[],
  snapshotId: string,
): EntityRow[] {
  return collapse(rows.map((row) => normalizeRecommendation(row, snapshotId)))
}
