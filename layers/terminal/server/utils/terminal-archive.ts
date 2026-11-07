// Reads of the archived price history (archive_captures, archived_prices):
// the Internet Archive's captures of each lab's own pricing page, backfilled
// by scripts/wayback-backfill.ts. Kept out of the live derivations on
// purpose. A live point says what this store saw when it looked; an archived
// one says what the Archive saw, and we read it back years later. Every
// archived row a payload carries says so (basis 'archived', a wayback:
// source id, the capture URL as source_url).

import { and, asc, count, desc, eq, inArray, lte, max, min } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type {
  ArchiveReach,
  ArchivedHiringPoint,
  LabId,
  PriceReach,
  PriceRowView,
} from '../../shared/utils/terminal-types'
import {
  ARCHIVE_ERAS,
  ARCHIVE_FROM,
  ARCHIVE_GAPS,
  ARCHIVE_NOT_COVERED,
} from '../pipeline/archive/eras'
import {
  HIRING_ARCHIVE_ERAS,
  HIRING_ARCHIVE_GAPS,
  HIRING_ARCHIVE_NOT_COVERED,
  HIRING_ARCHIVE_UNTIL,
  HIRING_GAP_DAYS,
  type HiringArchiveProvider,
} from '../pipeline/archive/hiring-eras'
import type { ArchiveAxis } from '../pipeline/archive/rows'
import type { PipelineDb } from '../pipeline/store'
import { PointInTimeError, firstSnapshotAt } from './terminal-asof'
import { inCluster, type DepartmentCluster } from './terminal-clusters'
import { archiveSourceId, type ArchivedPrice } from './terminal-history'
import { byString, num, parseJson, str } from './terminal-json'
import { HIRING_SOURCES, type SourceRegistry } from './terminal-sources'

export const ARCHIVE_SOURCE_NOTE =
  'Read from the Internet Archive’s capture of the lab’s own pricing page, before this site watched it.'

export const ARCHIVED_AS_OF_METHOD =
  'as_of is before this site’s first fetch, so this answer is rebuilt from the Internet Archive: per lab, the price list on the newest capture of its pricing page at or before as_of that we could read. That is event time (when the Archive saw the page), not knowledge time: we read these captures back long after, so this store did not hold them at as_of. Each row’s source_url is the capture, fetched_at when we read it. Labs with no readable capture by as_of have no rows. The like-for-like matrix is not rebuilt from the archive.'

/** archived_prices rows of one key, captured at or before `until`. */
export async function archivedRowsForKey(
  db: PipelineDb,
  key: string,
  until: string | null,
): Promise<ArchivedPrice[]> {
  const where = until
    ? and(eq(tables.archivedPrices.entity_key, key), lte(tables.archivedPrices.captured_at, until))
    : eq(tables.archivedPrices.entity_key, key)
  return db
    .select({
      capture_id: tables.archivedPrices.capture_id,
      entity_key: tables.archivedPrices.entity_key,
      content_hash: tables.archivedPrices.content_hash,
      payload: tables.archivedPrices.payload,
      captured_at: tables.archivedPrices.captured_at,
      source_url: tables.archivedPrices.source_url,
      fetched_at: tables.archivedPrices.fetched_at,
    })
    .from(tables.archivedPrices)
    .where(where)
    .orderBy(asc(tables.archivedPrices.captured_at))
}

/** Whether `at` is before the live floor, so a price read as of it must come from the archive. */
export async function beforeLiveFloor(db: PipelineDb, at: string): Promise<boolean> {
  const first = await firstSnapshotAt(db)
  return first === null || at < first
}

const parsedOn = (axis: ArchiveAxis) =>
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

export interface ArchivedCatalog {
  rows: PriceRowView[]
  /** The capture each lab's rows come from: what point_in_time cites. */
  captures: { provider: string; capture_id: string; captured_at: string; source_url: string }[]
}

/**
 * Every lab's price list as of `at`, from the archive: per lab, the rows of
 * its newest parsed capture at or before `at`. A lab whose newest readable
 * capture sits before a gap is still answered from it, and the payload's
 * point_in_time names that capture so the reader sees how old it is.
 */
export async function archivedCatalogAt(db: PipelineDb, at: string): Promise<ArchivedCatalog> {
  const newest = await db
    .select({
      provider: tables.archiveCaptures.provider,
      captured_at: max(tables.archiveCaptures.captured_at),
    })
    .from(tables.archiveCaptures)
    .where(and(parsedOn('pricing'), lte(tables.archiveCaptures.captured_at, at)))
    .groupBy(tables.archiveCaptures.provider)
  const captures: ArchivedCatalog['captures'] = []
  for (const n of newest) {
    if (!n.captured_at) continue
    const [c] = await db
      .select({
        id: tables.archiveCaptures.id,
        source_url: tables.archiveCaptures.source_url,
      })
      .from(tables.archiveCaptures)
      .where(
        and(
          eq(tables.archiveCaptures.provider, n.provider),
          parsedOn('pricing'),
          eq(tables.archiveCaptures.captured_at, n.captured_at),
        ),
      )
      .orderBy(desc(tables.archiveCaptures.id))
      .limit(1)
    if (c) {
      captures.push({
        provider: n.provider,
        capture_id: c.id,
        captured_at: n.captured_at,
        source_url: c.source_url,
      })
    }
  }
  captures.sort((a, b) => byString(a.provider, b.provider))
  if (captures.length === 0) return { rows: [], captures }

  const stored = await db
    .select()
    .from(tables.archivedPrices)
    .where(
      inArray(
        tables.archivedPrices.capture_id,
        captures.map((c) => c.capture_id),
      ),
    )
  const rows = stored.flatMap((r) => {
    const payload = parseJson(r.payload)
    if (!payload || typeof payload.model_slug !== 'string') return []
    return [archivedRowView(r, payload)]
  })
  rows.sort((a, b) => byString(a.entity_key, b.entity_key))
  return { rows, captures }
}

function archivedRowView(
  r: typeof tables.archivedPrices.$inferSelect,
  payload: Record<string, unknown>,
): PriceRowView {
  return {
    entity_key: r.entity_key,
    source_id: archiveSourceId(r.capture_id),
    provider: r.provider as PriceRowView['provider'],
    model_slug: str(payload.model_slug) ?? '?',
    tier: str(payload.tier),
    context_window: str(payload.context_window),
    context_window_source: null,
    input_per_mtok: num(payload.input_per_mtok),
    cached_input_per_mtok: num(payload.cached_input_per_mtok),
    output_per_mtok: num(payload.output_per_mtok),
    effective_from: str(payload.effective_from),
    effective_until: str(payload.effective_until),
    notes: [str(payload.notes), ARCHIVE_SOURCE_NOTE].filter(Boolean).join(' '),
    removed: false,
    delta: null,
    also_listed_by: [],
    revisions: 1,
    spark: null,
    source_url: r.source_url,
    fetched_at: r.fetched_at,
    checked_at: null,
  }
}

/** Every key the archive priced, with its newest capture day: sitemap entries for SKUs gone before we watched. */
export async function archivedPriceKeys(
  db: PipelineDb,
): Promise<{ entity_key: string; at: string }[]> {
  const rows = await db
    .select({
      entity_key: tables.archivedPrices.entity_key,
      at: max(tables.archivedPrices.captured_at),
    })
    .from(tables.archivedPrices)
    .groupBy(tables.archivedPrices.entity_key)
  return rows.flatMap((r) => (r.at ? [{ entity_key: r.entity_key, at: r.at }] : []))
}

const LABS: readonly LabId[] = ['openai', 'anthropic', 'google', 'xai', 'meta', 'mistral']

/**
 * How far each lab's price history reaches: the archived span and how many
 * captures were read or skipped, and the first fetch of the lab's live
 * pricing sources. Two grouped reads and one row per source.
 */
export async function queryPriceReach(
  db: PipelineDb,
  registry: SourceRegistry,
): Promise<PriceReach[]> {
  const [archived, live] = await Promise.all([
    db
      .select({
        provider: tables.archiveCaptures.provider,
        status: tables.archiveCaptures.status,
        n: count(),
        from: min(tables.archiveCaptures.captured_at),
        until: max(tables.archiveCaptures.captured_at),
      })
      .from(tables.archiveCaptures)
      .where(eq(tables.archiveCaptures.axis, 'pricing'))
      .groupBy(tables.archiveCaptures.provider, tables.archiveCaptures.status),
    db
      .select({
        source_id: tables.sourceStats.source_id,
        first: tables.sourceStats.first_fetched_at,
      })
      .from(tables.sourceStats),
  ])
  const pricingSources = new Map(
    registry.sources
      .filter((s) => s.axis === 'pricing-catalog')
      .map((s) => [s.source_id, s.provider]),
  )
  const covered = new Set(ARCHIVE_ERAS.map((e) => e.provider as string))
  return LABS.map((provider) => {
    const parsed = archived.find((a) => a.provider === provider && a.status === 'parsed')
    const skipped = archived.find((a) => a.provider === provider && a.status === 'skipped')
    const liveFirst = live
      .filter((l) => pricingSources.get(l.source_id) === provider && l.first)
      .map((l) => l.first!)
      .sort()[0]
    return {
      provider,
      archived_from: parsed?.from ?? null,
      archived_until: parsed?.until ?? null,
      archived_parsed: parsed?.n ?? 0,
      archived_skipped: skipped?.n ?? 0,
      live_from: liveFirst ?? null,
      gaps: covered.has(provider)
        ? ARCHIVE_GAPS.filter((g) => g.provider === provider).map(({ from, until, reason }) => ({
            from,
            until,
            reason,
          }))
        : [],
      not_covered: ARCHIVE_NOT_COVERED.find((n) => n.provider === provider)?.reason ?? null,
    }
  })
}

// ---- hiring ------------------------------------------------------------------

export const HIRING_ARCHIVE_METHOD =
  'Points before our first read of a board come from the Internet Archive’s copies of the lab’s own job board (source_id wayback:<era>). Each is the board as the Archive saw it at `at`. That is event time, not knowledge time: we read the copies back long after, at fetched_at, so this store did not hold them at `at`. We read one copy a week. A copy that lists every role gives departments. One that pages its list gives only the board’s own total. A copy we couldn’t read is skipped with its reason (archive_captures). Department labels are the board’s own at the time, filed under today’s department where the board’s own id ties the two. Archived points never reach alerts, theses or the judge.'

export const ARCHIVED_HIRING_AS_OF_METHOD =
  'as_of is before this site first read the boards, so this answer is rebuilt from the Internet Archive: per lab, the open roles on the newest copy of its job board at or before as_of that we could read. That is event time (when the Archive saw the board), not knowledge time: we read these copies back long after, so this store did not hold them at as_of. Each lab’s source_url is the copy, fetched_at when we read it. A copy that pages its list gives the board’s total with no departments. A lab with no readable copy by as_of has no rows.'

/**
 * Every lab's archived board counts at or before `until` (all of them when
 * null), one point per parsed capture, oldest first. Clusters are matched
 * over each row's live department and list the labels the board printed.
 */
export async function archivedHiringPoints(
  db: PipelineDb,
  clusters: readonly DepartmentCluster[],
  until: string | null,
): Promise<Map<string, ArchivedHiringPoint[]>> {
  const rows = await db
    .select({
      capture_id: tables.archivedHiring.capture_id,
      provider: tables.archivedHiring.provider,
      scope: tables.archivedHiring.scope,
      label: tables.archivedHiring.label,
      department: tables.archivedHiring.department,
      open_roles: tables.archivedHiring.open_roles,
      captured_at: tables.archivedHiring.captured_at,
      source_url: tables.archivedHiring.source_url,
      fetched_at: tables.archivedHiring.fetched_at,
    })
    .from(tables.archivedHiring)
    .where(until ? lte(tables.archivedHiring.captured_at, until) : undefined)
  const byCapture = new Map<string, typeof rows>()
  for (const r of rows) {
    const group = byCapture.get(r.capture_id)
    if (group) group.push(r)
    else byCapture.set(r.capture_id, [r])
  }

  const out = new Map<string, ArchivedHiringPoint[]>()
  for (const [captureId, group] of byCapture) {
    const board = group.find((r) => r.scope === 'board')
    if (!board) continue
    const listed = group.filter((r) => r.scope === 'department')
    const departments = listed.length
      ? listed
          .map((r) => ({
            department: r.department ?? r.label ?? '',
            label: r.label ?? '',
            open_roles: r.open_roles,
          }))
          .sort((a, b) => b.open_roles - a.open_roles || byString(a.label, b.label))
      : null
    const point: ArchivedHiringPoint = {
      at: board.captured_at,
      basis: 'archived',
      source_id: archiveSourceId(captureId),
      total: board.open_roles,
      departments,
      clusters: departments
        ? clusters.map((c) => {
            // Matched on the live department, so a department the board's id ties to
            // today's ("Infrastructure" then, "Software Engineering - Infrastructure"
            // now) is in or out of the cluster as it is live.
            const matched = departments.filter((d) => inCluster(d.department, c))
            return {
              id: c.id,
              label: c.label,
              open_roles: matched.reduce((n, d) => n + d.open_roles, 0),
              departments: matched.map((d) => d.label),
            }
          })
        : null,
      source_url: board.source_url,
      fetched_at: board.fetched_at,
    }
    const points = out.get(board.provider)
    if (points) points.push(point)
    else out.set(board.provider, [point])
  }
  for (const points of out.values()) {
    points.sort((a, b) => byString(a.at, b.at) || byString(a.source_id, b.source_id))
  }
  return out
}

const DAY_MS = 86_400_000
const dayOf = (iso: string) => iso.slice(0, 10)

/** [from, until] (YYYY-MM-DD) with every stated gap cut out of it. */
function withoutStated(
  span: [string, string],
  stated: readonly { from: string; until: string }[],
): [string, string][] {
  let pieces: [string, string][] = [span]
  for (const g of stated) {
    pieces = pieces.flatMap(([from, until]): [string, string][] => {
      if (g.until <= from || until <= g.from) return [[from, until]]
      return [
        ...(from < g.from ? [[from, g.from] as [string, string]] : []),
        ...(g.until < until ? [[g.until, until] as [string, string]] : []),
      ]
    })
  }
  return pieces
}

/** A skip reason without the ids and counts a parser names, so like reasons read as one. */
const skipKind = (detail: string | null) =>
  (detail ?? 'unreadable')
    .replace(/:?\s*https?:\/\/\S+/g, '')
    .replace(/\b[0-9a-f-]{8,}\b/g, '…')
    .replace(/\d+/g, 'N')

/**
 * How far each lab's hiring history reaches: the archived span, captures
 * read and skipped, the first fetch of its live board, and every stretch
 * longer than HIRING_GAP_DAYS with no readable copy, with why: the stated
 * reason where hiring-eras.ts gives one, else what the Archive held there.
 */
export async function queryHiringReach(
  db: PipelineDb,
  registry: SourceRegistry,
): Promise<ArchiveReach[]> {
  const [captures, live] = await Promise.all([
    db
      .select({
        provider: tables.archiveCaptures.provider,
        status: tables.archiveCaptures.status,
        captured_at: tables.archiveCaptures.captured_at,
        detail: tables.archiveCaptures.detail,
      })
      .from(tables.archiveCaptures)
      .where(eq(tables.archiveCaptures.axis, 'hiring'))
      .orderBy(asc(tables.archiveCaptures.captured_at)),
    db
      .select({
        source_id: tables.sourceStats.source_id,
        first: tables.sourceStats.first_fetched_at,
      })
      .from(tables.sourceStats),
  ])
  const known = new Set(registry.sources.map((s) => s.source_id))
  const covered = new Set(HIRING_ARCHIVE_ERAS.map((e) => e.provider as string))
  return LABS.map((provider) => {
    const backing = HIRING_SOURCES[provider]
    const primary = 'source_ids' in backing ? backing.source_ids[0]! : null
    const liveFirst =
      (primary !== null && known.has(primary)
        ? live.find((l) => l.source_id === primary)?.first
        : null) ?? null
    const mine = captures.filter((c) => c.provider === provider)
    const parsed = mine.filter((c) => c.status === 'parsed')
    const skipped = mine.filter((c) => c.status === 'skipped')
    const stated = HIRING_ARCHIVE_GAPS.filter((g) => g.provider === provider).map(
      ({ from, until, reason }) => ({ from, until, reason }),
    )
    const gaps = [...stated]
    if (covered.has(provider)) {
      const end = liveFirst ?? HIRING_ARCHIVE_UNTIL[provider as HiringArchiveProvider]
      const marks = [ARCHIVE_FROM, ...parsed.map((c) => c.captured_at), end]
      for (let i = 1; i < marks.length; i++) {
        const [a, b] = [dayOf(marks[i - 1]!), dayOf(marks[i]!)]
        // A stated gap explains its own stretch; what is left either side of it is computed.
        for (const [from, until] of withoutStated([a, b], stated)) {
          if (Date.parse(until) - Date.parse(from) <= HIRING_GAP_DAYS * DAY_MS) continue
          const lost = skipped.filter(
            (c) => dayOf(c.captured_at) > from && dayOf(c.captured_at) < until,
          )
          const kinds = [...new Set(lost.map((c) => skipKind(c.detail)))]
          const held = lost.length
            ? `We couldn’t read the Archive’s ${lost.length} ${lost.length === 1 ? 'copy' : 'copies'} of the board from this stretch (${kinds.slice(0, 3).join('; ')}).`
            : 'The Archive holds no copy of the board from this stretch.'
          const edge =
            i === 1 && parsed.length && until === b
              ? ` Its first copy we could read is from ${b}.`
              : i === marks.length - 1 && until === b
                ? ` We read the board live from ${b}.`
                : ''
          gaps.push({ from, until, reason: held + edge })
        }
      }
    }
    gaps.sort((x, y) => byString(x.from, y.from))
    return {
      provider,
      archived_from: parsed[0]?.captured_at ?? null,
      archived_until: parsed.at(-1)?.captured_at ?? null,
      archived_parsed: parsed.length,
      archived_skipped: skipped.length,
      live_from: liveFirst,
      gaps,
      not_covered: covered.has(provider)
        ? null
        : (HIRING_ARCHIVE_NOT_COVERED.find((n) => n.provider === provider)?.reason ?? null),
    }
  })
}
