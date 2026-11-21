// When the store's own record of an axis begins, and whether the Internet
// Archive backfill reaches further back: what decides if a point-in-time
// request (terminal-handler.ts › terminalPayloadAt) can be answered at all.
// The archived rows themselves are read in layers/pricing/server/utils/terminal-price-archive.ts
// (price lists) and layers/talent/server/utils/terminal-hiring-archive.ts (job boards).

import { and, eq, min } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type { LabId } from '../../shared/utils/terminal-types/common'
import type { PipelineDb } from '../pipeline/store'
import { HIRING_SOURCES, PROVIDER_ORDER, type SourceRegistry } from './terminal-sources'
import { PointInTimeError, firstSnapshotAt } from './terminal-asof'

/** The earliest instant the backfill looks at. */
export const ARCHIVE_FROM = '2023-01-01T00:00:00.000Z'

/** archive_captures.id is `<era>:<timestamp>`; a point's source_id names the era. */
export const archiveSourceId = (captureId: string) => `wayback:${captureId.split(':')[0]}`

/** The axes the Internet Archive backfill covers. */
export type ArchiveAxis = 'pricing' | 'hiring'

/** Whether `at` is before every lab's live floor, so the whole answer comes from the archive. */
export async function beforeLiveFloor(db: PipelineDb, at: string): Promise<boolean> {
  const first = await firstSnapshotAt(db)
  return first === null || at < first
}

/** Captures of `axis` that were read and stored. */
export const parsedOn = (axis: ArchiveAxis) =>
  and(eq(tables.archiveCaptures.status, 'parsed'), eq(tables.archiveCaptures.axis, axis))

/** The earliest parsed capture of an axis: before it, not even the archive knew a price (or a board). */
export async function firstArchivedAt(
  db: PipelineDb,
  axis: ArchiveAxis = 'pricing',
): Promise<string | null> {
  const [row] = await db
    .select({ at: min(tables.archiveCaptures.captured_at) })
    .from(tables.archiveCaptures)
    .where(parsedOn(axis))
  return row?.at ?? null
}

const WHAT: Record<ArchiveAxis, { history: string; list: string }> = {
  pricing: { history: 'price history', list: 'a price list' },
  hiring: { history: 'hiring history', list: 'a job board' },
}

/**
 * The refusal for an instant before anything was fetched, unless the archive
 * can answer it. Price and hiring routes call this in place of assertKnowable.
 */
export async function assertArchiveKnowable(
  db: PipelineDb,
  at: string,
  axis: ArchiveAxis = 'pricing',
): Promise<void> {
  if (!(await beforeLiveFloor(db, at))) return
  const archived = await firstArchivedAt(db, axis)
  if (archived !== null && at >= archived) return
  const first = await firstSnapshotAt(db)
  throw new PointInTimeError(
    archived === null
      ? `as_of ${at} is before the first snapshot (${first ?? 'none yet'}), and no archived ${WHAT[axis].history} is loaded`
      : `as_of ${at} is before the earliest archived ${axis === 'pricing' ? 'price' : 'job board'} capture (${archived}), so we have no ${WHAT[axis].list} for then`,
  )
}

/**
 * Where each lab's live record begins: the first fetch of its own pricing
 * pages ('pricing'), or of its primary job board ('hiring'). Labs joined at
 * different times (DeepSeek and Alibaba on 2026-11-04), so one floor for all
 * of them dropped a later lab between the archive's end and its own first
 * fetch. A lab never fetched has no entry; a lab with no board is left out of
 * 'hiring' entirely (labsBeforeFloor never names it).
 */
export async function labLiveFloors(
  db: PipelineDb,
  registry: SourceRegistry,
  axis: ArchiveAxis,
): Promise<Map<LabId, string>> {
  const live = await db
    .select({
      source_id: tables.sourceStats.source_id,
      first: tables.sourceStats.first_fetched_at,
    })
    .from(tables.sourceStats)
  const firstOf = new Map(live.flatMap((l) => (l.first ? [[l.source_id, l.first] as const] : [])))
  const out = new Map<LabId, string>()
  for (const lab of PROVIDER_ORDER) {
    const first = floorSources(registry, axis, lab)
      .map((id) => firstOf.get(id))
      .filter((at): at is string => at !== undefined)
      .sort()[0]
    if (first) out.set(lab, first)
  }
  return out
}

function floorSources(registry: SourceRegistry, axis: ArchiveAxis, lab: LabId): string[] {
  if (axis === 'hiring') {
    const backing = HIRING_SOURCES[lab]
    return 'source_ids' in backing ? [backing.source_ids[0]!] : []
  }
  return registry.sources
    .filter((s) => s.axis === 'pricing-catalog' && s.provider === lab)
    .map((s) => s.source_id)
}

/** The labs whose live record had not begun at `at`, whose answer comes from the archive. */
export function labsBeforeFloor(
  floors: ReadonlyMap<LabId, string>,
  at: string,
  axis: ArchiveAxis,
): LabId[] {
  return PROVIDER_ORDER.filter((lab) => {
    if (axis === 'hiring' && !('source_ids' in HIRING_SOURCES[lab])) return false
    const floor = floors.get(lab)
    return floor === undefined || at < floor
  })
}
