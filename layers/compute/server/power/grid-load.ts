// EIA-930 demand for the balancing authorities that hold a tracked lab site.
// With NUXT_EIA_API_KEY set, EIA's API v2 gives the days from 2019 on
// (eia-api.ts) and the six-month Grid Monitor files only 2018; without it, or
// on a run where the API fails, the files give everything. Each file
// is one half-year of every authority's hours, 30 to 47 MB: over the
// pipeline fetcher's body cap, so it is read here as a stream, one line at a
// time, and only the lines of the tracked authorities are kept. Those lines
// go to R2 verbatim, beside the file's header, so every stored day has its
// source bytes; the rest of the file is never held.
//
// A day is the sum of the hourly "Demand (MW) (Adjusted)" values, EIA's
// cleaned copy of what each authority reports, over the hours that carry one:
// megawatt-hours, with the hour count beside it so a short day reads as one.
//
// Each run reads the current half (skipped when EIA's ETag has not moved), the
// half before it for six weeks after it closes (EIA revises), and walks back
// through unread halves to EIA930_FIRST_PERIOD, BACKFILL_PER_RUN at a time.

import { and, eq, inArray, max, sql } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import {
  EIA_API_FIRST_DAY,
  EIA_API_OVERLAP_DAYS,
  eiaDailyUrl,
  readEiaDaily,
  zoneGroups,
} from './eia-api'
import { eia930FileUrl, Eia930Reader, periodsDue, periodsThrough, type GridDay } from './eia930'
import { D1_MAX_BOUND_PARAMS } from '#layers/core/server/utils/pipeline-store'

const GRID_FILE_TIMEOUT_MS = 120_000

interface GridFileRead {
  period: string
  status: 'read' | 'unchanged' | 'failed'
  days: number
  detail: string | null
}

interface GridLoadDeps {
  /** R2: the kept lines of each read. */
  put(key: string, body: string, contentType: string): Promise<void>
  fetch?: typeof globalThis.fetch
  userAgent: string
  now: Date
  /** NUXT_EIA_API_KEY. Empty or absent = the six-month files only. */
  apiKey?: string
}

/** The grid_load_files row the API reads keep (the files' rows are half-years). */
export const API_PERIOD = 'api'

const DAY_COLUMNS = 8

async function storeDays(
  db: PipelineDb,
  days: readonly GridDay[],
  at: { raw_key: string; url: string; fetched_at: string },
): Promise<void> {
  const rows = days.map((d) => ({
    ...d,
    raw_key: at.raw_key,
    first_seen_at: at.fetched_at,
    source_url: at.url,
    fetched_at: at.fetched_at,
  }))
  for (const part of chunk(rows, Math.floor(D1_MAX_BOUND_PARAMS / DAY_COLUMNS))) {
    await db
      .insert(tables.gridLoadDays)
      .values(part)
      .onConflictDoUpdate({
        target: [tables.gridLoadDays.ba, tables.gridLoadDays.date],
        set: {
          mwh: sql`excluded.mwh`,
          hours: sql`excluded.hours`,
          raw_key: sql`excluded.raw_key`,
          source_url: sql`excluded.source_url`,
          fetched_at: sql`excluded.fetched_at`,
        },
        setWhere: sql`excluded.mwh != ${tables.gridLoadDays.mwh} or excluded.hours != ${tables.gridLoadDays.hours}`,
      })
  }
}

async function readFile(
  db: PipelineDb,
  period: string,
  prior: { etag: string | null; content_hash: string | null } | undefined,
  deps: GridLoadDeps,
): Promise<GridFileRead> {
  const url = eia930FileUrl(period)
  const doFetch = deps.fetch ?? globalThis.fetch
  const headers: Record<string, string> = { 'User-Agent': deps.userAgent }
  if (prior?.etag) headers['If-None-Match'] = prior.etag
  const res = await doFetch(url, { headers, signal: AbortSignal.timeout(GRID_FILE_TIMEOUT_MS) })
  if (res.status === 304) return { period, status: 'unchanged', days: 0, detail: null }
  if (!res.ok || !res.body) {
    return { period, status: 'failed', days: 0, detail: `HTTP ${res.status}` }
  }
  const reader = new Eia930Reader(GRID_AREA_CODES)
  const decoder = new TextDecoder()
  const stream = res.body.getReader()
  for (;;) {
    const { done, value } = await stream.read()
    if (done) break
    reader.push(decoder.decode(value, { stream: true }))
  }
  reader.push(decoder.decode())
  const { lines, days } = reader.finish()
  const hash = contentHashOfText(lines)
  const fetched_at = deps.now.toISOString()
  const raw_key = `grid-load/eia930/${period}/${hash}.csv`
  const etag = res.headers.get('etag')
  if (hash !== prior?.content_hash) {
    await deps.put(raw_key, lines, 'text/csv')
    await storeDays(db, days, { raw_key, url, fetched_at })
  }
  await db
    .insert(tables.gridLoadFiles)
    .values({
      period,
      url,
      status: 'read',
      detail: null,
      etag,
      content_hash: hash,
      days: days.length,
      raw_key,
      read_at: fetched_at,
    })
    .onConflictDoUpdate({
      target: tables.gridLoadFiles.period,
      set: {
        status: 'read',
        detail: null,
        etag,
        content_hash: hash,
        days: days.length,
        raw_key,
        read_at: fetched_at,
      },
    })
  return {
    period,
    status: hash === prior?.content_hash ? 'unchanged' : 'read',
    days: days.length,
    detail: null,
  }
}

/** Each authority's newest stored day. */
async function newestDays(db: PipelineDb): Promise<Map<string, string>> {
  const rows = await db
    .select({ ba: tables.gridLoadDays.ba, at: max(tables.gridLoadDays.date) })
    .from(tables.gridLoadDays)
    .groupBy(tables.gridLoadDays.ba)
  return new Map(rows.map((r) => [r.ba, r.at ?? '']))
}

const daysBefore = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10)

/**
 * The API read: per EIA clock, every day from six weeks before the newest
 * stored day of its authorities (from 2019-01-01 for one with none since),
 * page by page. Throws on the first page that fails, so the run falls back to
 * the files.
 */
async function readApi(
  db: PipelineDb,
  deps: GridLoadDeps & { apiKey: string },
): Promise<GridFileRead> {
  const doFetch = deps.fetch ?? globalThis.fetch
  const newest = await newestDays(db)
  const fetched_at = deps.now.toISOString()
  let stored = 0
  let lastUrl = ''
  for (const [zone, areas] of zoneGroups()) {
    const since = areas
      .map((a) => {
        const n = newest.get(a.ba)
        return n && n >= EIA_API_FIRST_DAY ? daysBefore(n, EIA_API_OVERLAP_DAYS) : EIA_API_FIRST_DAY
      })
      .sort()[0]!
    const start = since < EIA_API_FIRST_DAY ? EIA_API_FIRST_DAY : since
    for (let offset = 0; ;) {
      const url = eiaDailyUrl({ bas: areas.map((a) => a.ba), zone, start, offset })
      const res = await doFetch(url, {
        headers: {
          'User-Agent': deps.userAgent,
          'X-Api-Key': deps.apiKey,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(GRID_FILE_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`EIA API HTTP ${res.status} (${zone}, offset ${offset})`)
      const body = await res.text()
      // The key travels in a header; a body that echoes it is never stored.
      if (body.includes(deps.apiKey))
        throw new Error('EIA API response contains the key; not stored')
      const page = readEiaDaily(body, areas)
      const raw_key = `grid-load/eia-api/${zone}/${contentHashOfText(body)}.json`
      await deps.put(raw_key, body, 'application/json')
      await storeDays(db, page.days, { raw_key, url, fetched_at })
      stored += page.days.length
      lastUrl = url
      offset += page.rows
      if (page.rows === 0 || offset >= page.total) break
    }
  }
  const row = {
    status: 'read',
    detail: null,
    etag: null,
    content_hash: null,
    days: stored,
    raw_key: null,
    read_at: fetched_at,
  }
  await db
    .insert(tables.gridLoadFiles)
    .values({ period: API_PERIOD, url: lastUrl, ...row })
    .onConflictDoUpdate({ target: tables.gridLoadFiles.period, set: { url: lastUrl, ...row } })
  return { period: API_PERIOD, status: 'read', days: stored, detail: null }
}

/**
 * One run. With a key, the API reads 2019 on and the files only the halves
 * before it; an API failure is spooled and the run reads the files as it
 * would with no key. Without one, the halves periodsDue names, in order. A
 * file failure is spooled and the walk stops.
 */
export async function runGridLoad(db: PipelineDb, deps: GridLoadDeps): Promise<GridFileRead[]> {
  const files = await db.select().from(tables.gridLoadFiles)
  const read = new Set(files.filter((f) => f.status === 'read').map((f) => f.period))
  const prior = new Map(files.map((f) => [f.period, f]))
  const out: GridFileRead[] = []
  let periods = periodsDue(deps.now, read)
  const apiKey = deps.apiKey?.trim()
  if (apiKey) {
    const api = await readApi(db, { ...deps, apiKey }).catch((error: unknown): GridFileRead => ({
      period: API_PERIOD,
      status: 'failed',
      days: 0,
      detail: String(error).replaceAll(apiKey, '[key]').slice(0, 300),
    }))
    out.push(api)
    if (api.status === 'failed') {
      await recordOpsEvent(db, {
        kind: 'grid_load_read_failed',
        detail: `EIA API, reading the six-month files instead: ${api.detail}`,
      })
    } else {
      const firstApiHalf = `${EIA_API_FIRST_DAY.slice(0, 4)}H1`
      periods = periodsThrough(deps.now).filter((p) => p < firstApiHalf && !read.has(p))
    }
  }
  for (const period of periods) {
    const r = await readFile(db, period, prior.get(period), deps).catch(
      (error: unknown): GridFileRead => ({
        period,
        status: 'failed',
        days: 0,
        detail: String(error).slice(0, 300),
      }),
    )
    out.push(r)
    if (r.status === 'failed') {
      // A half read before keeps its row as read: its days still stand.
      if (!read.has(period)) {
        await db
          .insert(tables.gridLoadFiles)
          .values({
            period,
            url: eia930FileUrl(period),
            status: 'failed',
            detail: r.detail,
            etag: null,
            content_hash: null,
            days: 0,
            raw_key: null,
            read_at: deps.now.toISOString(),
          })
          .onConflictDoUpdate({
            target: tables.gridLoadFiles.period,
            set: { status: 'failed', detail: r.detail, read_at: deps.now.toISOString() },
          })
      }
      await recordOpsEvent(db, {
        kind: 'grid_load_read_failed',
        detail: `EIA-930 ${period}: ${r.detail}`,
      })
      break
    }
  }
  return out
}

/** The days stored for some authorities, oldest first. */
export async function gridLoadDays(db: PipelineDb, bas: readonly string[]) {
  if (bas.length === 0) return []
  return db
    .select()
    .from(tables.gridLoadDays)
    .where(and(inArray(tables.gridLoadDays.ba, [...bas])))
    .orderBy(tables.gridLoadDays.ba, tables.gridLoadDays.date)
}

export async function gridLoadFilesRead(db: PipelineDb) {
  return db.select().from(tables.gridLoadFiles).where(eq(tables.gridLoadFiles.status, 'read'))
}
