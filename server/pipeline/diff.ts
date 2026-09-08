import { ChangeRow, contentHash, type EntityRow } from './contracts'

// Diff: two entity sets -> ChangeRow[] (boundary table, "diff" =
// DETERMINISTIC). Keyed on entity_key; added/removed by key presence,
// modified by content_hash inequality. detected_at is an INPUT — this module
// never reads a clock, so a change event is reproducible from two stored
// snapshots alone.

function indexByKey(rows: readonly EntityRow[], side: 'before' | 'after'): Map<string, EntityRow> {
  const byKey = new Map<string, EntityRow>()
  for (const row of rows) {
    const existing = byKey.get(row.entity_key)
    if (existing) {
      if (existing.content_hash !== row.content_hash) {
        throw new Error(`${side} set has conflicting rows for entity_key ${row.entity_key}`)
      }
      continue // byte-identical repeat — harmless
    }
    byKey.set(row.entity_key, row)
  }
  return byKey
}

export function diff(
  before: readonly EntityRow[],
  after: readonly EntityRow[],
  detected_at: string,
): ChangeRow[] {
  const beforeByKey = indexByKey(before, 'before')
  const afterByKey = indexByKey(after, 'after')

  // Union of keys, sorted — output order never depends on input order or
  // Map iteration order. Each key yields at most one ChangeRow, so
  // entity_key alone is a total order over the output.
  const keys = [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  )

  const changes: ChangeRow[] = []
  for (const key of keys) {
    const b = beforeByKey.get(key)
    const a = afterByKey.get(key)
    if (b && a && b.content_hash === a.content_hash) continue // unchanged

    const change_type = b && a ? 'modified' : a ? 'added' : 'removed'
    // Provenance: the after-side row where one exists (added/modified were
    // observed in the after snapshot); for removed rows the only evidence
    // carrying provenance is the before-side row — its last observation.
    const evidence = (a ?? b)!

    changes.push(
      ChangeRow.parse({
        // Deterministic id: pure function of the entity and the two
        // content hashes, so two runs over the same snapshots produce
        // byte-identical ids.
        id: contentHash({
          entity_key: key,
          before_hash: b?.content_hash ?? null,
          after_hash: a?.content_hash ?? null,
        }),
        entity_key: key,
        entity_type: evidence.entity_type,
        provider: evidence.provider,
        change_type,
        before_hash: b?.content_hash ?? null,
        after_hash: a?.content_hash ?? null,
        before_json: b?.payload ?? null,
        after_json: a?.payload ?? null,
        detected_at,
        source_url: evidence.source_url,
        fetched_at: evidence.fetched_at,
      }),
    )
  }
  return changes
}
