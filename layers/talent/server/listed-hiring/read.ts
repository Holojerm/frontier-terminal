// The daily read of the listed companies' job boards (LISTED_BOARDS). One
// request per board, in turn; Google's data-center roles come from the copy
// of its careers feed the careers lane already archived, so that board costs
// Google no request of its own.
//
// Each read stores the board's bytes in R2 (keyed by their hash, so an
// unchanged board adds nothing), writes one listed_hiring_reads row with the
// counts as they stood, and moves listed_jobs: new roles in, listed roles
// refreshed and re-classed, missing roles closed. A failed read writes its row
// with the reason and touches no role.

import { and, desc, eq, inArray } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { parseBoard, readGoogleFeed, type ListedRole } from './parsers'

export const BOARD_TIMEOUT_MS = 30_000

/** The careers lane's source whose archived copy the Google board reads. */
export const GOOGLE_FEED_SOURCE = 'google-careers'

/**
 * A board that had this many roles and now lists none has more likely changed
 * its API than closed every role: the read fails instead.
 */
export const EMPTIED_BOARD_FLOOR = 10

export interface ListedHiringDeps {
  /** R2 write. */
  put(key: string, body: string, contentType: string): Promise<void>
  /** R2 read as a stream, for the archived careers feed. */
  stream(key: string): Promise<ReadableStream<Uint8Array> | null>
  fetch?: typeof globalThis.fetch
  userAgent: string
  now: Date
}

export interface BoardResult {
  board: string
  status: 'read' | 'failed'
  total: number | null
  datacenter: number | null
  added: number
  closed: number
  detail: string | null
}

interface Fetched {
  roles: ListedRole[]
  source_url: string
  fetched_at: string
  content_hash: string
  raw_key: string
}

async function fetchBoard(
  db: PipelineDb,
  board: ListedBoard,
  deps: ListedHiringDeps,
  prior: { content_hash: string | null } | undefined,
): Promise<Fetched> {
  if (board.platform === 'google-feed') {
    const [snap] = await db
      .select({
        raw_key: tables.snapshots.raw_key,
        content_hash: tables.snapshots.content_hash,
        source_url: tables.snapshots.source_url,
        fetched_at: tables.snapshots.fetched_at,
      })
      .from(tables.snapshots)
      .where(eq(tables.snapshots.source_id, GOOGLE_FEED_SOURCE))
      .orderBy(desc(tables.snapshots.fetched_at))
      .limit(1)
    if (!snap) throw new Error('no archived copy of the careers feed yet')
    const body = await deps.stream(snap.raw_key)
    if (!body) throw new Error(`the archived feed ${snap.raw_key} is missing`)
    return {
      roles: await readGoogleFeed(body),
      source_url: snap.source_url,
      fetched_at: snap.fetched_at,
      content_hash: snap.content_hash,
      raw_key: snap.raw_key,
    }
  }
  const doFetch = deps.fetch ?? globalThis.fetch
  const res = await doFetch(board.url, {
    headers: { 'User-Agent': deps.userAgent, Accept: 'application/json', ...board.headers },
    signal: AbortSignal.timeout(BOARD_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.text()
  const roles = parseBoard(board.platform, body)
  const content_hash = contentHashOfText(body)
  const raw_key = `listed-hiring/${board.id}/${content_hash}.json`
  if (content_hash !== prior?.content_hash) await deps.put(raw_key, body, 'application/json')
  return {
    roles,
    source_url: board.url,
    fetched_at: deps.now.toISOString(),
    content_hash,
    raw_key,
  }
}

const JOB_COLUMNS = 12

type Content = Pick<ListedRole, 'title' | 'department' | 'location' | 'published_at'> & {
  role_class: string
}

const sameContent = (a: Content, b: Content) =>
  a.title === b.title &&
  a.department === b.department &&
  a.location === b.location &&
  a.published_at === b.published_at &&
  a.role_class === b.role_class

/**
 * Move the board's roles to what this read listed, writing only what
 * changed: a daily read of an unchanged board is one SELECT.
 */
async function storeRoles(
  db: PipelineDb,
  board: ListedBoard,
  fetched: Fetched,
  readAt: string,
): Promise<{ added: number; closed: number }> {
  const known = await db
    .select({
      job_id: tables.listedJobs.job_id,
      title: tables.listedJobs.title,
      department: tables.listedJobs.department,
      location: tables.listedJobs.location,
      published_at: tables.listedJobs.published_at,
      role_class: tables.listedJobs.role_class,
      closed_at: tables.listedJobs.closed_at,
    })
    .from(tables.listedJobs)
    .where(eq(tables.listedJobs.board_id, board.id))
  const byId = new Map(known.map((k) => [k.job_id, k]))
  const listed = new Set(fetched.roles.map((r) => r.job_id))

  const inserts = fetched.roles.filter((r) => !byId.has(r.job_id))
  const reopened = fetched.roles.filter((r) => byId.get(r.job_id)?.closed_at != null)
  const changed = fetched.roles.filter((r) => {
    const k = byId.get(r.job_id)
    return k !== undefined && (k.closed_at !== null || !sameContent(k, r))
  })
  const closing = known.filter((k) => k.closed_at === null && !listed.has(k.job_id))

  const statements = [
    ...chunk(
      inserts.map((r) => ({
        board_id: board.id,
        job_id: r.job_id,
        ticker: board.ticker,
        title: r.title,
        department: r.department,
        location: r.location,
        published_at: r.published_at,
        role_class: r.role_class,
        first_seen_at: readAt,
        closed_at: null,
        source_url: fetched.source_url,
        fetched_at: fetched.fetched_at,
      })),
      Math.floor(D1_MAX_BOUND_PARAMS / JOB_COLUMNS),
    ).map((part) => db.insert(tables.listedJobs).values(part)),
    ...changed.map((r) =>
      db
        .update(tables.listedJobs)
        .set({
          title: r.title,
          department: r.department,
          location: r.location,
          published_at: r.published_at,
          role_class: r.role_class,
          closed_at: null,
          source_url: fetched.source_url,
          fetched_at: fetched.fetched_at,
        })
        .where(
          and(eq(tables.listedJobs.board_id, board.id), eq(tables.listedJobs.job_id, r.job_id)),
        ),
    ),
    ...chunk(
      closing.map((k) => k.job_id),
      D1_MAX_BOUND_PARAMS - 2,
    ).map((ids) =>
      db
        .update(tables.listedJobs)
        .set({ closed_at: readAt })
        .where(
          and(eq(tables.listedJobs.board_id, board.id), inArray(tables.listedJobs.job_id, ids)),
        ),
    ),
  ]
  await runStatements(db, statements)
  return { added: inserts.length + reopened.length, closed: closing.length }
}

/** Read one board and record what it listed. Never throws: a failure is a failed read row. */
export async function readListedBoard(
  db: PipelineDb,
  board: ListedBoard,
  deps: ListedHiringDeps,
): Promise<BoardResult> {
  const readAt = deps.now.toISOString()
  const [prior] = await db
    .select({
      content_hash: tables.listedHiringReads.content_hash,
      total: tables.listedHiringReads.total,
      datacenter: tables.listedHiringReads.datacenter,
    })
    .from(tables.listedHiringReads)
    .where(
      and(
        eq(tables.listedHiringReads.board_id, board.id),
        eq(tables.listedHiringReads.status, 'read'),
      ),
    )
    .orderBy(desc(tables.listedHiringReads.read_at))
    .limit(1)
  const base = {
    id: `${board.id}:${readAt}`,
    board_id: board.id,
    ticker: board.ticker,
    read_at: readAt,
  }
  try {
    const fetched = await fetchBoard(db, board, deps, prior)
    const before = (board.scope === 'all' ? prior?.total : prior?.datacenter) ?? 0
    if (fetched.roles.length === 0 && before >= EMPTIED_BOARD_FLOOR) {
      throw new Error(`the board lists no roles, after ${before} at the last read`)
    }
    const { added, closed } = await storeRoles(db, board, fetched, readAt)
    const count = (c: ListedRole['role_class']) =>
      fetched.roles.filter((r) => r.role_class === c).length
    const counts = {
      total: board.scope === 'all' ? fetched.roles.length : null,
      datacenter: count('datacenter'),
      infrastructure: board.scope === 'all' ? count('infrastructure') : null,
    }
    await db.insert(tables.listedHiringReads).values({
      ...base,
      status: 'read',
      detail: null,
      ...counts,
      added,
      closed,
      content_hash: fetched.content_hash,
      raw_key: fetched.raw_key,
      source_url: fetched.source_url,
      fetched_at: fetched.fetched_at,
    })
    return { board: board.id, status: 'read', ...counts, added, closed, detail: null }
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).slice(0, 500)
    await db.insert(tables.listedHiringReads).values({
      ...base,
      status: 'failed',
      detail,
      total: null,
      datacenter: null,
      infrastructure: null,
      added: null,
      closed: null,
      content_hash: null,
      raw_key: null,
      source_url: board.url,
      fetched_at: readAt,
    })
    return {
      board: board.id,
      status: 'failed',
      total: null,
      datacenter: null,
      added: 0,
      closed: 0,
      detail,
    }
  }
}

/** Read every board in turn; one ops event names the boards that failed. */
export async function runListedHiring(
  db: PipelineDb,
  deps: ListedHiringDeps,
  boards: readonly ListedBoard[] = LISTED_BOARDS,
): Promise<BoardResult[]> {
  const results: BoardResult[] = []
  for (const board of boards) results.push(await readListedBoard(db, board, deps))
  const failed = results.filter((r) => r.status === 'failed')
  if (failed.length) {
    await recordOpsEvent(db, {
      kind: 'listed_hiring_read_failed',
      detail: failed.map((f) => `${f.board}: ${f.detail}`).join('; '),
    })
  }
  return results
}
