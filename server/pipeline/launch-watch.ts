import { and, eq, gte } from 'drizzle-orm'

import * as tables from '../db/schema'
import { recordOpsEvent } from '../utils/ops'
import { basisChecks } from '../utils/terminal-db'
import { effectiveClassMap } from './class-map'
import type { LockStore } from './lock'
import type { PipelineDb } from './store'

// Launch-day coverage: does the site show a launch it has already stored?
//
// On the Opus 5.5 launch the rows were in the store from 18:01, and at 22:51
// the site still showed no alert for it and Opus 5 as Anthropic's flagship,
// marked "under review". Refresh does spool one ops event when a cell loses
// its sentence, but one line in one digest is easy to miss, and nothing at
// all noticed the missing alert. This module checks both every half hour and
// keeps saying so until they are fixed:
//
//   stale cell   a matrix cell whose vendor sentence has been gone for more
//                than an hour: the flagship on the page is not the one the
//                vendor now recommends, and the judge (hourly, at :17) has
//                not re-mapped it. Re-announced every six hours.
//   unalerted    a model slug new to the store in the last week that no
//                alert cites two hours after it landed. model-floor.ts should
//                make this impossible, so this is the check on that rule.
//                Announced once per slug.
//
// The markers live in KV beside the poll lock. /api/fleet reports the same
// two lists as counts, so the dashboard shows a launch gap before the digest
// is read.

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export const STALE_CELL_AFTER_MS = HOUR_MS
export const STALE_CELL_RENOTIFY_SECONDS = (6 * HOUR_MS) / 1000
/** The judge runs hourly at :17, so two hours covers one full run after the rows landed. */
export const UNALERTED_AFTER_MS = 2 * HOUR_MS
export const LAUNCH_WINDOW_MS = 7 * DAY_MS
export const UNALERTED_MARKER_TTL_SECONDS = LAUNCH_WINDOW_MS / 1000

export interface StaleCell {
  provider: string
  class: string
  model_slug: string
  /** When the poll first found the sentence gone. */
  since: string
}

export interface UnalertedModel {
  provider: string
  model_slug: string
  first_seen_at: string
}

export interface LaunchCoverage {
  stale_cells: StaleCell[]
  unalerted: UnalertedModel[]
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

const slugOf = (json: string | null): string | null => {
  if (!json) return null
  const slug = (JSON.parse(json) as { model_slug?: unknown }).model_slug
  return typeof slug === 'string' ? slug : null
}

async function unalertedModels(db: PipelineDb, now: Date): Promise<UnalertedModel[]> {
  const windowStart = new Date(now.getTime() - LAUNCH_WINDOW_MS).toISOString()
  const settled = now.getTime() - UNALERTED_AFTER_MS

  // First sighting per slug across every catalog. A slug one catalog has
  // listed for months is not new because a second one started listing it.
  const models = await db
    .select({
      provider: tables.entities.provider,
      payload: tables.entities.payload,
      first_seen_at: tables.entities.first_seen_at,
    })
    .from(tables.entities)
    .where(eq(tables.entities.entity_type, 'model'))
  const firstSeen = new Map<string, UnalertedModel>()
  for (const row of models) {
    const slug = slugOf(row.payload)
    if (!slug) continue
    const key = `${row.provider}:${slug}`
    const seen = firstSeen.get(key)
    if (!seen || row.first_seen_at < seen.first_seen_at) {
      firstSeen.set(key, {
        provider: row.provider,
        model_slug: slug,
        first_seen_at: row.first_seen_at,
      })
    }
  }
  const candidates = [...firstSeen.entries()].filter(
    ([, m]) => m.first_seen_at >= windowStart && Date.parse(m.first_seen_at) <= settled,
  )
  if (candidates.length === 0) return []

  // A slug is covered when any alert cites any 'added' change on it.
  const added = await db
    .select({
      id: tables.changes.id,
      provider: tables.changes.provider,
      after_json: tables.changes.after_json,
    })
    .from(tables.changes)
    .where(
      and(
        eq(tables.changes.entity_type, 'model'),
        eq(tables.changes.change_type, 'added'),
        gte(tables.changes.detected_at, windowStart),
      ),
    )
  const alerts = await db
    .select({ change_ids: tables.alerts.change_ids })
    .from(tables.alerts)
    .where(gte(tables.alerts.created_at, windowStart))
  const cited = new Set(alerts.flatMap((a) => JSON.parse(a.change_ids) as string[]))
  const covered = new Set<string>()
  const hasChange = new Set<string>()
  for (const change of added) {
    const key = `${change.provider}:${slugOf(change.after_json)}`
    hasChange.add(key)
    if (cited.has(change.id)) covered.add(key)
  }
  // A slug with no 'added' change arrived in a baseline: the source was new,
  // not the model, and there is nothing to alert about.
  return candidates
    .filter(([key]) => hasChange.has(key) && !covered.has(key))
    .map(([, m]) => m)
    .sort((a, b) => a.first_seen_at.localeCompare(b.first_seen_at))
}

export async function launchCoverage(
  db: PipelineDb,
  now: Date = new Date(),
): Promise<LaunchCoverage> {
  return { stale_cells: await staleCells(db, now), unalerted: await unalertedModels(db, now) }
}

export const staleMarkerKey = (c: StaleCell) =>
  `launch:stale:${c.provider}:${c.class}:${c.model_slug}`
export const unalertedMarkerKey = (m: UnalertedModel) =>
  `launch:unalerted:${m.provider}:${m.model_slug}`

/** One ops:alert tick: spool an event for each gap not reported recently. */
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
        'vendor page; if it has not, re-transcribe it in server/utils/terminal-classes.ts.',
    })
    await marker.put(key, now.toISOString(), STALE_CELL_RENOTIFY_SECONDS)
  }
  for (const model of coverage.unalerted) {
    const key = unalertedMarkerKey(model)
    if ((await marker.get(key)) !== null) continue
    await recordOpsEvent(db, {
      kind: 'launch_unalerted',
      detail:
        `${model.provider} ${model.model_slug} first listed ${model.first_seen_at} ` +
        'and no alert cites it — check the model-floor rule and the judge.',
    })
    await marker.put(key, now.toISOString(), UNALERTED_MARKER_TTL_SECONDS)
  }
  return coverage
}
