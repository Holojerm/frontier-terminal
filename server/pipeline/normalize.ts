import {
  AshbyJobRow,
  EntityRow,
  contentHash,
  filingKey,
  jobKey,
  modelKey,
  stableStringify,
  type FilingRow,
  type PriceRow,
  type Provider,
} from './contracts'

// Normalize: validated parser-output rows -> EntityRow (boundary table,
// "normalize" = DETERMINISTIC). Pure functions of their inputs: no clock,
// no randomness, no iteration-order dependence.

// Ashby and Greenhouse rows share one shape (jobRowCore in
// contracts/parsers.ts); the inferred type of either schema covers both.
export type JobRow = ReturnType<typeof AshbyJobRow.parse>

// Canonical serialization: the same stableStringify that backs contentHash
// (one algorithm), so contentHash(JSON.parse(payload)) === content_hash and
// a change event is reproducible from the stored payloads alone.
export { stableStringify }

// payload/content_hash cover the row MINUS source_url/fetched_at.
// Provenance travels in the EntityRow columns instead: hashing fetched_at
// would mark every row "modified" on every re-fetch even when the source
// content is byte-identical, poisoning every diff downstream.
function toEntity(
  entity_key: string,
  entity_type: 'job' | 'model' | 'filing',
  provider: Provider,
  snapshotId: string,
  row: Record<string, unknown> & { source_url: string; fetched_at: string },
): EntityRow {
  const { source_url, fetched_at, ...content } = row
  return EntityRow.parse({
    entity_key,
    entity_type,
    provider,
    snapshot_id: snapshotId,
    content_hash: contentHash(content),
    payload: stableStringify(content),
    source_url,
    fetched_at,
  })
}

export function normalizeJob(row: JobRow, snapshotId: string): EntityRow {
  return toEntity(jobKey(row.provider, row.job_id), 'job', row.provider, snapshotId, row)
}

export function normalizePrice(row: PriceRow, snapshotId: string): EntityRow {
  return toEntity(
    modelKey(row.provider, row.model_slug, row.tier),
    'model',
    row.provider,
    snapshotId,
    row,
  )
}

// FilingRow carries no provider field: EDGAR filers (SPCX, MSFT, ...) are
// whitelisted public companies, not the private big-4 labs, so the default
// is "other". Callers override only when a filing is genuinely a lab's own
// (the S-1 public-flip moment).
export function normalizeFiling(
  row: FilingRow,
  snapshotId: string,
  provider: Provider = 'other',
): EntityRow {
  return toEntity(filingKey(row.accession_no), 'filing', provider, snapshotId, row)
}

const byEntityKey = (a: EntityRow, b: EntityRow): number =>
  a.entity_key < b.entity_key ? -1 : a.entity_key > b.entity_key ? 1 : 0

// SKU dedupe (boundary table, normalize row): byte-identical repeats of one
// entity_key collapse to a single row; the same key with DIFFERENT content
// is a parser bug (incomplete tier disambiguation) and must fail loudly
// rather than silently pick a winner.
function collapse(rows: EntityRow[]): EntityRow[] {
  const byKey = new Map<string, EntityRow>()
  for (const row of rows) {
    const existing = byKey.get(row.entity_key)
    if (existing) {
      if (existing.content_hash !== row.content_hash) {
        throw new Error(
          `conflicting rows for entity_key ${row.entity_key}: hashes ${existing.content_hash} vs ${row.content_hash}`,
        )
      }
      continue
    }
    byKey.set(row.entity_key, row)
  }
  return [...byKey.values()].sort(byEntityKey)
}

export function normalizeJobs(rows: readonly JobRow[], snapshotId: string): EntityRow[] {
  return collapse(rows.map((row) => normalizeJob(row, snapshotId)))
}

export function normalizePrices(rows: readonly PriceRow[], snapshotId: string): EntityRow[] {
  return collapse(rows.map((row) => normalizePrice(row, snapshotId)))
}

export function normalizeFilings(
  rows: readonly FilingRow[],
  snapshotId: string,
  provider: Provider = 'other',
): EntityRow[] {
  return collapse(rows.map((row) => normalizeFiling(row, snapshotId, provider)))
}
