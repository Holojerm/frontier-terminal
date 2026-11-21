import {
  disclosureKey,
  disclosureTimelineKey,
  type DisclosureRow,
  type DisclosureTimelineRow,
  type EntityRow,
} from '../../../core/server/utils/contracts'
import { collapse, toEntity } from '../../../core/server/pipeline/normalize'

// Normalize the misalignment disclosures: validated disclosure rows -> EntityRow
// (boundary table, "normalize" = DETERMINISTIC).

// A disclosure entry is keyed by its kind and the index's own id for it, so
// a revised summary diffs as 'modified' on the same entry.
export function normalizeDisclosures(
  rows: readonly DisclosureRow[],
  snapshotId: string,
): EntityRow[] {
  return collapse(
    rows.map((row) =>
      toEntity(
        disclosureKey(row.provider, row.kind, row.entry_id),
        'disclosure',
        row.provider,
        snapshotId,
        row,
      ),
    ),
  )
}

export function normalizeDisclosureTimelines(
  rows: readonly DisclosureTimelineRow[],
  snapshotId: string,
): EntityRow[] {
  return collapse(
    rows.map((row) =>
      toEntity(
        disclosureTimelineKey(row.provider, row.entry_id),
        'disclosure_timeline',
        row.provider,
        snapshotId,
        row,
      ),
    ),
  )
}
