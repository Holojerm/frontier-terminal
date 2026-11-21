import { incidentKey, type EntityRow, type IncidentRow } from '../../../core/server/utils/contracts'
import { collapse, toEntity } from '../../../core/server/pipeline/normalize'

// Normalize the status feeds: validated incident rows -> EntityRow (boundary
// table, "normalize" = DETERMINISTIC).

function normalizeIncident(row: IncidentRow, snapshotId: string): EntityRow {
  return toEntity(
    incidentKey(row.provider, row.incident_id),
    'incident',
    row.provider,
    snapshotId,
    row,
  )
}

export function normalizeIncidents(rows: readonly IncidentRow[], snapshotId: string): EntityRow[] {
  return collapse(rows.map((row) => normalizeIncident(row, snapshotId)))
}
