import { eq } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { recordOpsEvent } from '#server/utils/ops'
import { basisChecks } from '../utils/terminal-prices'
import { effectiveClassMap } from './class-map'
import type { LockStore } from './lock'
import type { PipelineDb } from './store'

// Launch-day coverage: does the site show a launch it has already stored?
//
// On the Opus 5.5 launch the rows were in the store from 18:01, and at 22:51
// the site still showed no alert for it and Opus 5 as Anthropic's flagship,
// marked "under review". The missing alert is model-floor.ts's to prevent: it
// writes in the same transaction as the change rows. The stale cell is this
// module's. Refresh spools one class_basis_stale the moment a cell loses its
// sentence, but one line in one digest is easy to miss, so every half hour
// this reports a matrix cell whose vendor sentence has been gone for more
// than an hour (the judge, hourly at :17, has had its run and not re-mapped
// it) as class_basis_still_stale, again every six hours until it is fixed.
// Both stay: this one waits out the judge's run before asking the owner, so
// it never fires at the flip and cannot stand in for refresh's event there.
//
// The markers live in KV beside the poll lock. /api/fleet reports the count,
// so the dashboard shows a stale cell before the digest is read.

const HOUR_MS = 60 * 60 * 1000

const STALE_CELL_AFTER_MS = HOUR_MS
const STALE_CELL_RENOTIFY_SECONDS = (6 * HOUR_MS) / 1000

export interface StaleCell {
  provider: string
  class: string
  model_slug: string
  /** When the poll first found the sentence gone. */
  since: string
}

export interface LaunchCoverage {
  stale_cells: StaleCell[]
}

async function staleCells(db: PipelineDb, now: Date): Promise<StaleCell[]> {
  const entities = await db
    .select()
    .from(tables.entities)
    .where(eq(tables.entities.entity_type, 'recommendation'))
  const checks = basisChecks(entities)
  const cutoff = now.getTime() - STALE_CELL_AFTER_MS
  const out: StaleCell[] = []
  for (const entry of await effectiveClassMap(db)) {
    const check = checks.get(`${entry.provider}:${entry.class}`)
    // A check for a slug the map no longer names is about the old transcription.
    if (!check || check.present || check.model_slug !== entry.model_slug) continue
    if (Date.parse(check.fetched_at) > cutoff) continue
    out.push({
      provider: entry.provider,
      class: entry.class,
      model_slug: entry.model_slug,
      since: check.fetched_at,
    })
  }
  return out
}

export async function launchCoverage(
  db: PipelineDb,
  now: Date = new Date(),
): Promise<LaunchCoverage> {
  return { stale_cells: await staleCells(db, now) }
}

const staleMarkerKey = (c: StaleCell) => `launch:stale:${c.provider}:${c.class}:${c.model_slug}`

/** One ops:watch tick: spool an event for each gap not reported recently. */
export async function checkLaunchCoverage(
  db: PipelineDb,
  marker: LockStore,
  now: Date = new Date(),
): Promise<LaunchCoverage> {
  const coverage = await launchCoverage(db, now)
  for (const cell of coverage.stale_cells) {
    const key = staleMarkerKey(cell)
    if ((await marker.get(key)) !== null) continue
    await recordOpsEvent(db, {
      kind: 'class_basis_still_stale',
      detail:
        `${cell.provider} ${cell.class} still shows ${cell.model_slug}; its vendor sentence ` +
        `has been gone since ${cell.since}. The judge re-maps a cell under review from the ` +
        'vendor page; if it has not, re-transcribe it in layers/terminal/server/utils/terminal-classes.ts.',
    })
    await marker.put(key, now.toISOString(), STALE_CELL_RENOTIFY_SECONDS)
  }
  return coverage
}
