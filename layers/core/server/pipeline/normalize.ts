import { EntityRow, contentHash, stableStringify, type Provider } from '../utils/contracts'

// The two steps every domain's normalizers share: a validated parser-output
// row becomes an EntityRow (toEntity), and a page's rows collapse to one per
// entity_key (collapse). Pure functions of their inputs: no clock, no
// randomness, no iteration-order dependence.

// payload/content_hash cover the row MINUS source_url/fetched_at.
// Provenance travels in the EntityRow columns instead: hashing fetched_at
// would mark every row "modified" on every re-fetch even when the source
// content is byte-identical, poisoning every diff downstream.
export function toEntity(
  entity_key: string,
  entity_type: EntityRow['entity_type'],
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

const byEntityKey = (a: EntityRow, b: EntityRow): number =>
  a.entity_key < b.entity_key ? -1 : a.entity_key > b.entity_key ? 1 : 0

// SKU dedupe (boundary table, normalize row): byte-identical repeats of one
// entity_key collapse to a single row; the same key with DIFFERENT content
// is a parser bug (incomplete tier disambiguation) and must fail loudly
// rather than silently pick a winner.
export function collapse(rows: EntityRow[]): EntityRow[] {
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
