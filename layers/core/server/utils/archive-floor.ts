// When the store's own record of an axis begins, and whether the Internet
// Archive backfill reaches further back: what decides if a point-in-time
// request (terminal-handler.ts › terminalPayloadAt) can be answered at all.
// The archived rows themselves are read in layers/terminal/server/utils/terminal-archive.ts.

import { and, eq, min } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type { PipelineDb } from '../pipeline/store'
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
