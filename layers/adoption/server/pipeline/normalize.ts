import {
  rankingKey,
  type EntityRow,
  type RankingRow,
} from '../../../core/server/pipeline/contracts'
import { collapse, toEntity } from '../../../core/server/pipeline/normalize'

// Normalize the OpenRouter rankings: validated ranking rows -> EntityRow
// (boundary table, "normalize" = DETERMINISTIC).

// A ranking row is one (UTC day, model) observation. Its provider is the
// permaslug prefix the parser already resolved; total_tokens is the whole
// content, so a revised count diffs as one 'modified' row for that day.
export function normalizeRanking(row: RankingRow, snapshotId: string): EntityRow {
  return toEntity(
    rankingKey(row.date, row.model_permaslug),
    'ranking',
    row.provider,
    snapshotId,
    row,
  )
}

export function normalizeRankings(rows: readonly RankingRow[], snapshotId: string): EntityRow[] {
  return collapse(rows.map((row) => normalizeRanking(row, snapshotId)))
}
