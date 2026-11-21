import { AshbyJobRow, jobKey, type EntityRow } from '../../../core/server/utils/contracts'
import { collapse, toEntity } from '../../../core/server/pipeline/normalize'

// Normalize the job boards: validated job rows -> EntityRow (boundary table,
// "normalize" = DETERMINISTIC).

// Ashby and Greenhouse rows share one shape (jobRowCore in
// contracts/parsers.ts); the inferred type of either schema covers both.
export type JobRow = ReturnType<typeof AshbyJobRow.parse>

export function normalizeJob(row: JobRow, snapshotId: string): EntityRow {
  return toEntity(jobKey(row.provider, row.job_id), 'job', row.provider, snapshotId, row)
}

export function normalizeJobs(rows: readonly JobRow[], snapshotId: string): EntityRow[] {
  return collapse(rows.map((row) => normalizeJob(row, snapshotId)))
}
