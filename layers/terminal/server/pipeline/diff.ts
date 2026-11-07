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

/**
 * `detected_at` is the fetch of the after snapshot, and `after_url` its URL
 * (the before row's URL when not given): together they name the snapshot a
 * removal is cited to.
 */
export function diff(
  before: readonly EntityRow[],
  after: readonly EntityRow[],
  detected_at: string,
  after_url?: string,
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
    // observed in the after snapshot). A removal is observed in the after
    // snapshot too, as an absence. The before row's fetched_at is no use: it
    // only moves when the row's content changes, so for a role or a model
    // that never changed it is the first sighting, weeks before the removal.
    const evidence = (a ?? b)!
    const provenance = a
      ? { source_url: a.source_url, fetched_at: a.fetched_at }
      : { source_url: after_url ?? b!.source_url, fetched_at: detected_at }

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
        ...provenance,
      }),
    )
  }
  return changes
}
