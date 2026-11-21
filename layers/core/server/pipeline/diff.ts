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

export interface Diff {
  changes: ChangeRow[]
  /**
   * The after rows the store must write: every added or modified row, plus
   * any whose content is unchanged but whose provider or source_url differs
   * from the stored row. Neither is in the content hash, so no change is
   * logged for those, yet the stored row would otherwise keep the old value
   * forever: a revenue filer retagged to another lab in sources.yaml, or a
   * source that moved URL with byte-identical content. The world did not
   * change, our description of it did.
   */
  upserts: EntityRow[]
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
): Diff {
  const beforeByKey = indexByKey(before, 'before')
  const afterByKey = indexByKey(after, 'after')

  // Union of keys, sorted — output order never depends on input order or
  // Map iteration order. Each key yields at most one ChangeRow, so
  // entity_key alone is a total order over the output.
  const keys = [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  )

  const changes: ChangeRow[] = []
  const upserts: EntityRow[] = []
  for (const key of keys) {
    const b = beforeByKey.get(key)
    const a = afterByKey.get(key)
    if (b && a && b.content_hash === a.content_hash) {
      if (b.provider !== a.provider || b.source_url !== a.source_url) upserts.push(a)
      continue
    }
    if (a) upserts.push(a)

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
        id: changeId(key, b?.content_hash ?? null, a?.content_hash ?? null),
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
  return { changes, upserts }
}

/** A change's id: the entity and its two content hashes, no source and no clock. */
export function changeId(
  entity_key: string,
  before_hash: string | null,
  after_hash: string | null,
): string {
  return contentHash({ entity_key, before_hash, after_hash })
}

/**
 * The id for a transition the entity has made before and since moved on from
 * (a role closed, reposted, closed again; a price 15 → 10 → 15 → 10). changeId
 * alone would name the earlier row, which the store skips as already logged,
 * so the repeat would vanish. detected_at tells the two apart and is still an
 * input, so the id stays reproducible from the stored rows.
 */
export function repeatChangeId(change: ChangeRow): ChangeRow {
  return {
    ...change,
    id: contentHash({
      entity_key: change.entity_key,
      before_hash: change.before_hash,
      after_hash: change.after_hash,
      detected_at: change.detected_at,
    }),
  }
}
