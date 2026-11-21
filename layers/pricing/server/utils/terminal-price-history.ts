// A SKU's price series as pure functions over rows: the live observations
// (the current entities and the change log, every past state being the
// current one with the later changes undone) and the archived captures.
// terminal-prices.ts fetches the rows; nothing here touches D1, so the history
// tests drive every rule with a handful of fixture rows. No clock is read.

import type { PricePoint } from '../../shared/types/prices'

import type * as tables from '#server/db/schema'
import { byString, fieldDiff, num, parseJson } from '#layers/core/server/utils/terminal-json'
import { archiveSourceId } from '#layers/core/server/utils/archive-floor'
import { byDetectedAt } from '#layers/core/server/utils/terminal-db'

type Change = typeof tables.changes.$inferSelect
type Entity = typeof tables.entities.$inferSelect

const at = (iso: string) => Date.parse(iso)

// ---- price history ---------------------------------------------------------

/**
 * Every observation of one SKU key, oldest first. Each change row is a point (a removal
 * carries the last price seen); each current entity row is a 'current' point unless it is the
 * same fetch a change already recorded (an entity rewrite and its change share a fetched_at).
 * When the earliest change carries a before state, that state held from the source's first
 * snapshot until the change (any move in between would be in the log), so it opens the
 * series as a 'baseline' point stamped with that snapshot.
 */
export function priceHistory(
  entities: readonly Entity[],
  changes: readonly Change[],
  sourceIdOf: (url: string) => string,
  firstSnapshotOf: (url: string) => string | null = () => null,
): PricePoint[] {
  const points: PricePoint[] = []
  const seen = new Set<string>()
  const point = (
    kind: PricePoint['kind'],
    when: string,
    payload: Record<string, unknown>,
    source_url: string,
    fetched_at: string,
    diff: PricePoint['diff'] = [],
  ): PricePoint => ({
    at: when,
    kind,
    basis: 'live',
    source_id: sourceIdOf(source_url),
    input_per_mtok: num(payload.input_per_mtok),
    cached_input_per_mtok: num(payload.cached_input_per_mtok),
    output_per_mtok: num(payload.output_per_mtok),
    diff,
    source_url,
    fetched_at,
  })

  const sorted = [...changes].sort(byDetectedAt)
  const earliest = sorted[0]
  const opening = earliest ? parseJson(earliest.before_json) : null
  if (earliest && opening) {
    const first = firstSnapshotOf(earliest.source_url)
    if (first !== null && at(first) < at(earliest.detected_at)) {
      points.push(point('baseline', first, opening, earliest.source_url, first))
    }
  }
  for (const c of sorted) {
    const before = parseJson(c.before_json)
    const after = parseJson(c.after_json)
    const payload = c.change_type === 'removed' ? before : after
    if (!payload) continue
    seen.add(`${c.source_url}\n${c.fetched_at}`)
    const diff = c.change_type === 'modified' ? fieldDiff(before, after) : []
    points.push(
      point(
        c.change_type as PricePoint['kind'],
        c.detected_at,
        payload,
        c.source_url,
        c.fetched_at,
        diff,
      ),
    )
  }
  for (const e of [...entities].sort((a, b) => byString(a.source_id, b.source_id))) {
    if (seen.has(`${e.source_url}\n${e.fetched_at}`)) continue
    const payload = parseJson(e.payload)
    if (payload) points.push(point('current', e.fetched_at, payload, e.source_url, e.fetched_at))
  }
  // A current point observed in the same instant as a change sorts after it.
  return points.sort(
    (a, b) => at(a.at) - at(b.at) || Number(a.kind === 'current') - Number(b.kind === 'current'),
  )
}

/** What archivedPriceHistory reads: archived_prices rows of one key. */
export type ArchivedPrice = Pick<
  typeof tables.archivedPrices.$inferSelect,
  | 'capture_id'
  | 'entity_key'
  | 'content_hash'
  | 'payload'
  | 'captured_at'
  | 'source_url'
  | 'fetched_at'
>

/**
 * One SKU's Internet Archive observations as points, oldest first: the first
 * capture that printed each new state of the row. A capture repeating the
 * state before it adds nothing, so a price that held for a year is one point,
 * not fifty. Captures are sampled (layers/core/server/pipeline/archive/wayback.ts › sampleCaptures), so a
 * point's `at` is the first sampled capture showing that state, not the day
 * the lab changed it.
 */
export function archivedPriceHistory(rows: readonly ArchivedPrice[]): PricePoint[] {
  const sorted = [...rows].sort(
    (a, b) => at(a.captured_at) - at(b.captured_at) || byString(a.capture_id, b.capture_id),
  )
  const points: PricePoint[] = []
  let prev: ArchivedPrice | null = null
  for (const r of sorted) {
    if (prev && prev.content_hash === r.content_hash) continue
    const payload = parseJson(r.payload)
    if (!payload) continue
    points.push({
      at: r.captured_at,
      kind: 'archived',
      basis: 'archived',
      source_id: archiveSourceId(r.capture_id),
      input_per_mtok: num(payload.input_per_mtok),
      cached_input_per_mtok: num(payload.cached_input_per_mtok),
      output_per_mtok: num(payload.output_per_mtok),
      diff: prev ? fieldDiff(parseJson(prev.payload), payload) : [],
      source_url: r.source_url,
      fetched_at: r.fetched_at,
    })
    prev = r
  }
  return points
}

/** The sparkline's series: input prices when any exist, else output; null under two points. */
export function sparkOf(
  points: readonly PricePoint[],
): { field: 'input_per_mtok' | 'output_per_mtok'; values: (number | null)[] } | null {
  if (points.length < 2) return null
  const field = points.some((p) => p.input_per_mtok !== null) ? 'input_per_mtok' : 'output_per_mtok'
  return { field, values: points.map((p) => p[field]) }
}
