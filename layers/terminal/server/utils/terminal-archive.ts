// Reads of the archived hiring history (archive_captures, archived_hiring):
// the Internet Archive's captures of each lab's own job board, backfilled by
// scripts/wayback-backfill.ts. The archived price lists are read in
// layers/pricing/server/utils/terminal-price-archive.ts. Kept out of the live derivations on
// purpose. A live point says what this store saw when it looked; an archived
// one says what the Archive saw, and we read it back years later. Every
// archived row a payload carries says so (basis 'archived', a wayback:
// source id, the capture URL as source_url).

import { asc, eq, lte } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type { ArchiveReach, ArchivedHiringPoint, LabId } from '../../shared/utils/terminal-types'
import {
  HIRING_ARCHIVE_ERAS,
  HIRING_ARCHIVE_GAPS,
  HIRING_ARCHIVE_NOT_COVERED,
  HIRING_ARCHIVE_UNTIL,
  HIRING_GAP_DAYS,
  type HiringArchiveProvider,
} from '../pipeline/archive/hiring-eras'
import type { PipelineDb } from '#layers/core/server/pipeline/store'
import { ARCHIVE_FROM, archiveSourceId } from '#layers/core/server/utils/archive-floor'
import { inCluster, type DepartmentCluster } from './terminal-clusters'
import { byString } from '#layers/core/server/utils/terminal-json'
import { HIRING_SOURCES, type SourceRegistry } from '#layers/core/server/utils/terminal-sources'

/** The labs with an archived job-board history to reach back through (hiring-eras.ts). */
const HIRING_LABS: readonly LabId[] = ['openai', 'anthropic', 'google', 'xai', 'meta', 'mistral']

export const HIRING_ARCHIVE_METHOD =
  'Points before our first read of a board come from the Internet Archive’s copies of the lab’s own job board (source_id wayback:<era>). Each is the board as the Archive saw it at `at`. That is event time, not knowledge time: we read the copies back long after, at fetched_at, so this store did not hold them at `at`. We read one copy a week. A copy that lists every role gives departments. One that pages its list gives only the board’s own total. A copy we couldn’t read is skipped with its reason (archive_captures). Department labels are the board’s own at the time, filed under today’s department where the board’s own id ties the two. Archived points never reach alerts, theses or the judge.'

export const ARCHIVED_LAB_BOARDS_AS_OF_METHOD =
  'Each lab’s live hiring record starts at our first read of its own job board, and some boards were added later than others. A lab whose board we hadn’t read by as_of is answered from the Internet Archive: the open roles on the newest copy of its job board at or before as_of that we could read. That is event time (when the Archive saw the board), not knowledge time: we read these copies back long after. Its source_url is the copy, fetched_at when we read it.'

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
  return HIRING_LABS.map((provider) => {
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
