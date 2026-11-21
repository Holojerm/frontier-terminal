// A derived view of the stored history, as pure functions over rows: the
// model-release timeline (open roles per day are the talent layer's
// terminal-hiring-history.ts, a SKU's price series the pricing layer's
// terminal-price-history.ts). terminal-releases.ts fetches the rows; nothing here
// touches D1 or reads a clock.
//
// The store keeps the current entity set plus an append-only change log
// (server/db/schema.ts), so every past state is the current one with the later
// changes undone.

import type * as tables from '#server/db/schema'

type Change = typeof tables.changes.$inferSelect

const at = (iso: string) => Date.parse(iso)

// ---- baseline --------------------------------------------------------------

export const isBaseline = (change: Change, instants: ReadonlySet<string>): boolean =>
  change.change_type === 'added' && instants.has(`${change.source_url}\n${change.fetched_at}`)

// ---- releases --------------------------------------------------------------

/**
 * "New SKU listed" events: every `added` change on a model row that is not
 * a baseline sighting, newest first. The price is the one printed beside
 * the listing when it was first seen; a later reprice is on the SKU's page.
 * Two pages listing one key (the Anthropic pair) are one release: the
 * earliest sighting is the row, a priced one first on a tie, and the other
 * page is cited on it.
 */
export function releaseEvents(
  changes: readonly Change[],
  baseline: ReadonlySet<string>,
  sourceIdOf: (url: string) => string,
): { rows: ReleaseView[]; excluded_baseline: number } {
  const sightings: ReleaseView[] = []
  let excluded = 0
  for (const c of [...changes].sort(byDetectedAt)) {
    if (c.entity_type !== 'model' || c.change_type !== 'added') continue
    if (isBaseline(c, baseline)) {
      excluded++
      continue
    }
    const after = parseJson(c.after_json)
    if (!after || typeof after.model_slug !== 'string') continue
    sightings.push({
      change_id: c.id,
      entity_key: c.entity_key,
      source_id: sourceIdOf(c.source_url),
      provider: c.provider as ReleaseView['provider'],
      model_slug: after.model_slug,
      tier: str(after.tier),
      context_window: str(after.context_window),
      first_seen_at: c.detected_at,
      input_per_mtok: num(after.input_per_mtok),
      cached_input_per_mtok: num(after.cached_input_per_mtok),
      output_per_mtok: num(after.output_per_mtok),
      notes: str(after.notes),
      also_listed_by: [],
      source_url: c.source_url,
      fetched_at: c.fetched_at,
    })
  }
  const priced = (r: ReleaseView) => r.input_per_mtok !== null || r.output_per_mtok !== null
  const byKey = new Map<string, ReleaseView>()
  for (const s of sightings) {
    const held = byKey.get(s.entity_key)
    if (!held) {
      byKey.set(s.entity_key, s)
      continue
    }
    const sameInstant = at(held.first_seen_at) === at(s.first_seen_at)
    if (sameInstant && !priced(held) && priced(s)) {
      s.also_listed_by = [...held.also_listed_by, held.source_id]
      byKey.set(s.entity_key, s)
    } else {
      held.also_listed_by.push(s.source_id)
    }
  }
  const rows = [...byKey.values()]
  for (const r of rows) r.also_listed_by.sort(byString)
  rows.sort(
    (a, b) =>
      at(b.first_seen_at) - at(a.first_seen_at) ||
      byString(a.provider, b.provider) ||
      byString(a.entity_key, b.entity_key),
  )
  return { rows, excluded_baseline: excluded }
}
