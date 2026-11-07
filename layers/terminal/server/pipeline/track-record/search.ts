// Find candidates for each material alert: the GDELT articles and the lab's
// own newsroom posts within WINDOW_DAYS either side of when the terminal saw
// the change, matched on terms built from the cited change rows (terms.ts).
// Candidates only: the judge decides which are the same event (review.ts).
//
// The two sides run in different places. The newsroom side reads posts the
// poll already stored, so the */5 cron does it here (runTrackRecordSearch),
// once an alert's window has closed.
//
// The press side reads GDELT's 15-minute GKG files (gkg.ts), each once, in
// order, off the Worker: an Actions job (scripts/gdelt-search.ts) asks /api/gdelt/work for the next unread files and
// the alerts whose windows cover them (gkgWork), reads each file, and posts
// the rows that match an alert's terms to /api/gdelt/file (recordGkgFile).
// The Worker parses and matches every posted row again with this same code
// before keeping it, so the job can neither pick the matches nor fill an
// alert it was not handed. Candidates collect while a window is open; once
// every file in the window has been read, the cron writes the side's search
// row. Backfill is the same path: the queue starts at GKG_FROM.
//
// Each file is matched against the alerts that exist when it is read, so the
// files from before an alert was written were never matched to it: the half
// of its window before the terminal saw the change, which is where a press
// lead would be, goes unsearched for any alert written after its files were
// read. The search row records where the search actually began (its
// window_start, pressSearchedFrom), and the page leaves a window searched
// only in part out of the lead/lag tally rather than count it as a lead.
//
// GDELT's search API was used before (rows with a DOC API source_url). It
// limits requests per IP and answered most queries with a 429 from every IP
// we tried; the page ignores those rows' failures (terminal-track-record.ts).

import { and, asc, count, eq, gte, inArray, lte, min, sql } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { ChangeRow, contentHash } from '../contracts'
import type { RawStore } from '../refresh'
import { D1_MAX_BOUND_PARAMS, chunk, type PipelineDb } from '../store'
import { NEWSROOM_OF } from '../../theses/recipes/newsrooms'
import { PRESS_CANDIDATE_LIMIT, titleKey } from './gdelt'
import { GKG_BASE, GKG_SLOT_MS, gkgSlots, gkgStamp, gkgUrl, parseGkgRow, stampIso } from './gkg'
import { alertTerms, gdeltQuery, matchesArticle, matchesWhat, type SearchTerms } from './terms'
import { TRACK_RECORD_FROM, sawIt, searchState, trackWindow, type TrackWindow } from './window'

export const MATERIAL_SEVERITIES = ['notable', 'critical'] as const

/** GKG files handed out per /api/gdelt/work call: about two minutes of the job's reading. */
export const GKG_FILES_PER_CALL = 24

/** Newsroom posts kept per alert, earliest first. */
export const NEWSROOM_CANDIDATE_LIMIT = 10

export interface AlertForSearch {
  id: string
  created_at: string
  /** When the alert row was written; created_at for rows from before the column. */
  recorded_at: string
  changes: ChangeRow[]
}

/** Notable and critical alerts since TRACK_RECORD_FROM, oldest first, with their cited rows. */
export async function materialAlerts(db: PipelineDb): Promise<AlertForSearch[]> {
  const alerts = await db
    .select({
      id: tables.alerts.id,
      created_at: tables.alerts.created_at,
      recorded_at: tables.alerts.recorded_at,
      change_ids: tables.alerts.change_ids,
    })
    .from(tables.alerts)
    .where(
      and(
        gte(tables.alerts.created_at, TRACK_RECORD_FROM),
        inArray(tables.alerts.severity, [...MATERIAL_SEVERITIES]),
      ),
    )
    .orderBy(asc(tables.alerts.created_at), asc(tables.alerts.id))
  const ids = alerts.flatMap((a) => JSON.parse(a.change_ids) as string[])
  const byId = new Map<string, ChangeRow>()
  for (const group of chunk([...new Set(ids)], D1_MAX_BOUND_PARAMS - 10)) {
    const rows = await db.select().from(tables.changes).where(inArray(tables.changes.id, group))
    for (const row of rows) byId.set(row.id, ChangeRow.parse(row))
  }
  return alerts.map((a) => ({
    id: a.id,
    created_at: a.created_at,
    recorded_at: a.recorded_at ?? a.created_at,
    changes: (JSON.parse(a.change_ids) as string[])
      .map((id) => byId.get(id))
      .filter((c): c is ChangeRow => c !== undefined),
  }))
}

export interface NewsroomPost {
  key: string
  title: string
  link: string
  published_at: string
  summary: string
  source_url: string
  fetched_at: string
}

/** Stored newsroom posts of `recipeIds` published inside the window. */
export async function newsroomPosts(
  db: PipelineDb,
  recipeIds: readonly string[],
  window: TrackWindow,
): Promise<NewsroomPost[]> {
  if (recipeIds.length === 0) return []
  const rows = await db
    .select()
    .from(tables.recipeObservations)
    .where(
      and(
        inArray(tables.recipeObservations.recipe_id, [...recipeIds]),
        gte(tables.recipeObservations.date, window.start.slice(0, 10)),
      ),
    )
  const posts: NewsroomPost[] = []
  for (const row of rows) {
    const p = JSON.parse(row.payload) as Record<string, unknown>
    const published_at = typeof p.published_at === 'string' ? p.published_at : null
    if (!published_at || published_at < window.start || published_at > window.end) continue
    posts.push({
      key: row.key,
      title: String(p.title ?? ''),
      link: String(p.link ?? row.key),
      published_at,
      summary: String(p.summary ?? ''),
      source_url: row.source_url,
      fetched_at: row.fetched_at,
    })
  }
  return posts.sort(
    (a, b) => a.published_at.localeCompare(b.published_at) || a.key.localeCompare(b.key),
  )
}

/** The newsroom recipes for the labs an alert's rows belong to. */
export function newsroomsFor(changes: readonly ChangeRow[]): string[] {
  return [...new Set(changes.map((c) => NEWSROOM_OF[c.provider]?.id).filter(Boolean))] as string[]
}

/** Posts that carry one of the alert's `what` phrases, earliest first, capped. */
export function newsroomCandidates(
  posts: readonly NewsroomPost[],
  terms: SearchTerms,
): NewsroomPost[] {
  return posts
    .filter((p) => matchesWhat(`${p.title} ${p.summary}`, terms))
    .slice(0, NEWSROOM_CANDIDATE_LIMIT)
}

const hostOf = (url: string) => new URL(url).hostname.replace(/^www\./, '')

export const candidateId = (alert_id: string, kind: 'press' | 'newsroom', url: string) =>
  contentHash({ alert_id, kind, url })

async function searchesOf(db: PipelineDb) {
  return db
    .select({
      alert_id: tables.trackRecordSearches.alert_id,
      source: tables.trackRecordSearches.source,
      status: tables.trackRecordSearches.status,
    })
    .from(tables.trackRecordSearches)
}

export interface SearchDeps {
  now: () => Date
}

export interface SearchRunReport {
  /** Newsroom searches written this run. */
  newsroom: number
  /** GDELT searches written this run: alerts whose window's files have all been read. */
  gdelt: number
  /** Searches recorded as skipped: no search terms. */
  skipped: number
  candidates: number
}

interface SearchRow {
  id: string
  alert_id: string
  source: 'gdelt' | 'newsroom'
  query: string
  window_start: string
  window_end: string
  status: 'ok' | 'failed' | 'skipped'
  detail: string | null
  candidates: number
  searched_at: string
  raw_key: string | null
  source_url: string
}

interface AlertPlan {
  alert: AlertForSearch
  window: TrackWindow
  terms: SearchTerms | null
  gdeltDone: boolean
  newsroomDone: boolean
}

/** Every material alert with a saw-it time, oldest first, with its window and what is done. */
async function alertPlans(db: PipelineDb): Promise<AlertPlan[]> {
  const [alerts, searches] = await Promise.all([materialAlerts(db), searchesOf(db)])
  const done = new Set<string>()
  for (const s of searches) {
    if (s.status === 'ok' || s.status === 'skipped') done.add(`${s.alert_id}:${s.source}`)
  }
  const plans: AlertPlan[] = []
  for (const alert of alerts) {
    const saw = sawIt(alert.changes)
    if (!saw) continue
    plans.push({
      alert,
      window: trackWindow(saw.at),
      terms: alertTerms(alert.changes),
      gdeltDone: done.has(`${alert.id}:gdelt`),
      newsroomDone: done.has(`${alert.id}:newsroom`),
    })
  }
  return plans
}

/** Every GKG file already read, ok or missing. */
async function readStamps(db: PipelineDb): Promise<Set<string>> {
  const rows = await db.select({ stamp: tables.gdeltFiles.stamp }).from(tables.gdeltFiles)
  return new Set(rows.map((r) => r.stamp))
}

/** The quarter hours whose file is due and not read yet, oldest first. */
export function unreadStamps(now: Date, read: ReadonlySet<string>): string[] {
  return gkgSlots(now).filter((s) => !read.has(s))
}

/**
 * Whether every GKG file a window needs has been read: the quarter hour its
 * end falls in is due, and nothing before its end is unread. A file is due
 * GKG_READY_MS after its quarter hour, so a window that closed a moment ago
 * waits for its last files.
 */
export function windowRead(
  window: TrackWindow,
  lastDue: string | null,
  oldestUnread: string | null,
): boolean {
  if (!lastDue || Date.parse(stampIso(lastDue)) + GKG_SLOT_MS < Date.parse(window.end)) return false
  return oldestUnread === null || Date.parse(stampIso(oldestUnread)) >= Date.parse(window.end)
}

/**
 * A file read this soon after an alert was written may still have been
 * matched without it: the job takes the alert list once per batch of
 * GKG_FILES_PER_CALL files (about two minutes of reading), so a file only
 * counts as searched for an alert when it was recorded this long after.
 */
export const GKG_WORK_LAG_MS = 15 * 60_000

/**
 * The quarter hour from which the press side was actually searched for an
 * alert: the earliest file in its window recorded GKG_WORK_LAG_MS or more
 * after the alert was written. window.end when none was, so a window searched
 * not at all reads as empty rather than complete.
 */
export async function pressSearchedFrom(
  db: PipelineDb,
  written: string,
  window: TrackWindow,
): Promise<string> {
  const after = new Date(Date.parse(written) + GKG_WORK_LAG_MS).toISOString()
  const [row] = await db
    .select({ stamp: min(tables.gdeltFiles.stamp) })
    .from(tables.gdeltFiles)
    .where(
      and(
        gte(tables.gdeltFiles.stamp, gkgStamp(Date.parse(window.start) - GKG_SLOT_MS + 1)),
        lte(tables.gdeltFiles.stamp, gkgStamp(Date.parse(window.end))),
        sql`julianday(${tables.gdeltFiles.recorded_at}) >= julianday(${after})`,
      ),
    )
  const from = row?.stamp ? stampIso(row.stamp) : window.end
  return Date.parse(from) < Date.parse(window.start) ? window.start : from
}

/** Whether a press search began later than its window: the part before it was never searched. */
export function searchedInPart(search: { window_start: string }, window: TrackWindow): boolean {
  return Date.parse(search.window_start) > Date.parse(window.start) + GKG_SLOT_MS
}

const baseOf = (p: AlertPlan, searched_at: string) => ({
  alert_id: p.alert.id,
  window_start: p.window.start,
  window_end: p.window.end,
  searched_at,
})

async function pressCounts(db: PipelineDb, alertIds: readonly string[]) {
  const out = new Map<string, number>()
  for (const group of chunk([...alertIds], D1_MAX_BOUND_PARAMS - 5)) {
    const rows = await db
      .select({ alert_id: tables.trackRecordCandidates.alert_id, n: count() })
      .from(tables.trackRecordCandidates)
      .where(
        and(
          eq(tables.trackRecordCandidates.kind, 'press'),
          inArray(tables.trackRecordCandidates.alert_id, group),
        ),
      )
      .groupBy(tables.trackRecordCandidates.alert_id)
    for (const r of rows) out.set(r.alert_id, r.n)
  }
  return out
}

/**
 * The cron's half, for every alert whose window has closed: the newsroom
 * side, the GDELT side's search row once every file in the window has been
 * read, and a skip for an alert with no search terms. Never fetches anything.
 */
export async function runTrackRecordSearch(
  db: PipelineDb,
  deps: SearchDeps,
): Promise<SearchRunReport> {
  const report: SearchRunReport = { newsroom: 0, gdelt: 0, skipped: 0, candidates: 0 }
  const now = deps.now()
  const closed = (await alertPlans(db)).filter(
    (p) => searchState(p.window, now) !== 'open' && !(p.gdeltDone && p.newsroomDone),
  )
  if (closed.length === 0) return report
  const lastDue = gkgSlots(now).at(-1) ?? null
  const oldestUnread = unreadStamps(now, await readStamps(db))[0] ?? null
  const counts = await pressCounts(
    db,
    closed.map((p) => p.alert.id),
  )

  for (const p of closed) {
    const searched_at = deps.now().toISOString()
    const base = baseOf(p, searched_at)

    if (!p.terms) {
      // A ranking or other row with no press shape: nothing to search, said once.
      for (const source of ['gdelt', 'newsroom'] as const) {
        if (source === 'gdelt' ? p.gdeltDone : p.newsroomDone) continue
        await insertSearch(db, {
          ...base,
          id: crypto.randomUUID(),
          source,
          query: '',
          status: 'skipped',
          detail: 'no search terms for the cited change types',
          candidates: 0,
          raw_key: null,
          source_url: source === 'gdelt' ? GKG_BASE : '',
        })
        report.skipped++
      }
      continue
    }

    if (!p.newsroomDone) {
      const recipeIds = newsroomsFor(p.alert.changes)
      const posts = newsroomCandidates(await newsroomPosts(db, recipeIds, p.window), p.terms)
      const search_id = crypto.randomUUID()
      await insertSearch(db, {
        ...base,
        id: search_id,
        source: 'newsroom',
        query: p.terms.what.join(' | '),
        status: recipeIds.length ? 'ok' : 'skipped',
        detail: recipeIds.length ? null : 'no newsroom feed for this lab',
        candidates: posts.length,
        raw_key: null,
        source_url: recipeIds.map((id) => NEWSROOM_URLS[id] ?? id).join(' '),
      })
      await insertCandidates(
        db,
        posts.map((post) => ({
          id: candidateId(p.alert.id, 'newsroom', post.link),
          alert_id: p.alert.id,
          kind: 'newsroom',
          title: post.title,
          snippet: post.summary || null,
          outlet: hostOf(post.link),
          url: post.link,
          published_at: post.published_at,
          search_id,
          found_at: searched_at,
          source_url: post.source_url,
          fetched_at: post.fetched_at,
        })),
      )
      report.newsroom++
      report.candidates += posts.length
    }

    if (!p.gdeltDone && windowRead(p.window, lastDue, oldestUnread)) {
      // The candidates were stored as each file was read; this row says the
      // window is complete, from where its search began.
      await insertSearch(db, {
        ...base,
        window_start: await pressSearchedFrom(db, p.alert.recorded_at, p.window),
        id: crypto.randomUUID(),
        source: 'gdelt',
        query: gdeltQuery(p.terms),
        status: 'ok',
        detail: null,
        candidates: counts.get(p.alert.id) ?? 0,
        raw_key: null,
        source_url: GKG_BASE,
      })
      report.gdelt++
    }
  }
  return report
}

export interface GkgAlert {
  alert_id: string
  window_start: string
  window_end: string
  terms: SearchTerms
}

/** Material alerts with search terms whose window overlaps [from, to], oldest first. */
async function alertsOverlapping(db: PipelineDb, from: string, to: string): Promise<GkgAlert[]> {
  const out: GkgAlert[] = []
  for (const p of await alertPlans(db)) {
    if (!p.terms || p.window.end < from || p.window.start > to) continue
    out.push({
      alert_id: p.alert.id,
      window_start: p.window.start,
      window_end: p.window.end,
      terms: p.terms,
    })
  }
  return out
}

export interface GkgWork {
  files: { stamp: string; url: string }[]
  /** The alerts whose windows overlap these files; each row is matched against the ones covering its quarter hour. */
  alerts: GkgAlert[]
}

/** The next unread GKG files, oldest first, and the alerts to match them against. */
export async function gkgWork(
  db: PipelineDb,
  now: Date,
  limit: number = GKG_FILES_PER_CALL,
): Promise<GkgWork> {
  const stamps = unreadStamps(now, await readStamps(db)).slice(0, limit)
  if (stamps.length === 0) return { files: [], alerts: [] }
  const alerts = await alertsOverlapping(db, stampIso(stamps[0]!), stampIso(stamps.at(-1)!))
  return { files: stamps.map((stamp) => ({ stamp, url: gkgUrl(stamp) })), alerts }
}

export interface GkgFileInput {
  stamp: string
  /** When the job downloaded the file. */
  fetched_at: string
  /** missing: GDELT answered 404, it never published that quarter hour. */
  status: 'ok' | 'missing'
  /** Rows the file held. */
  rows: number
  /** Each row the job matched to an alert, exactly as the file has it. */
  matches: { alert_id: string; row: string }[]
}

export type GkgFileOutcome =
  | { recorded: true; candidates: number; duplicates: number; rejected: number }
  | { recorded: false; reason: 'not-due' }

/**
 * Store one GKG file the job read: the file's row, its matched rows in R2, and
 * those rows as press candidates. Only for a file that is due and not read
 * yet. A posted match is kept only when the Worker parses the row, finds it in
 * this file's quarter hour, inside the alert's window, and matching the
 * alert's terms itself; anything else is counted as rejected. Per alert, a
 * headline already held and anything past PRESS_CANDIDATE_LIMIT are dropped
 * as duplicates, so the earliest reports are the ones kept.
 */
export async function recordGkgFile(
  db: PipelineDb,
  raw: RawStore,
  input: GkgFileInput,
  now: Date,
): Promise<GkgFileOutcome> {
  if (!gkgSlots(now).includes(input.stamp)) return { recorded: false, reason: 'not-due' }
  const [already] = await db
    .select({ stamp: tables.gdeltFiles.stamp })
    .from(tables.gdeltFiles)
    .where(eq(tables.gdeltFiles.stamp, input.stamp))
  if (already) return { recorded: false, reason: 'not-due' }

  const seen_at = stampIso(input.stamp)
  const url = gkgUrl(input.stamp)
  const alerts = new Map(
    (await alertsOverlapping(db, seen_at, seen_at)).map((a) => [a.alert_id, a] as const),
  )

  const held = new Map<string, { ids: Set<string>; titles: Set<string> }>()
  const existing = alerts.size
    ? await db
        .select({
          id: tables.trackRecordCandidates.id,
          alert_id: tables.trackRecordCandidates.alert_id,
          title: tables.trackRecordCandidates.title,
        })
        .from(tables.trackRecordCandidates)
        .where(
          and(
            eq(tables.trackRecordCandidates.kind, 'press'),
            inArray(tables.trackRecordCandidates.alert_id, [...alerts.keys()]),
          ),
        )
    : []
  const heldOf = (alert_id: string) => {
    let h = held.get(alert_id)
    if (!h) held.set(alert_id, (h = { ids: new Set(), titles: new Set() }))
    return h
  }
  for (const c of existing) {
    const h = heldOf(c.alert_id)
    h.ids.add(c.id)
    h.titles.add(titleKey(c.title))
  }

  const rows: CandidateRow[] = []
  const lines: string[] = []
  let rejected = 0
  let duplicates = 0
  for (const match of input.status === 'ok' ? input.matches : []) {
    const alert = alerts.get(match.alert_id)
    const article = parseGkgRow(match.row)
    if (
      !alert ||
      !article ||
      article.seen_at !== seen_at ||
      !matchesArticle(article, alert.terms)
    ) {
      rejected++
      continue
    }
    const h = heldOf(alert.alert_id)
    const id = candidateId(alert.alert_id, 'press', article.url)
    const key = titleKey(article.title)
    if (h.ids.has(id) || h.titles.has(key) || h.ids.size >= PRESS_CANDIDATE_LIMIT) {
      duplicates++
      continue
    }
    h.ids.add(id)
    h.titles.add(key)
    if (!lines.includes(match.row)) lines.push(match.row)
    rows.push({
      id,
      alert_id: alert.alert_id,
      kind: 'press',
      title: article.title,
      snippet: null,
      outlet: article.outlet,
      url: article.url,
      published_at: article.seen_at,
      search_id: `gkg:${input.stamp}`,
      found_at: now.toISOString(),
      source_url: url,
      fetched_at: input.fetched_at,
    })
  }

  const raw_key = lines.length ? `track-record/gkg/${input.stamp}.tsv` : null
  if (raw_key) await raw.put(raw_key, `${lines.join('\n')}\n`, 'text/tab-separated-values')
  await insertCandidates(db, rows)
  await db.insert(tables.gdeltFiles).values({
    stamp: input.stamp,
    url,
    status: input.status,
    rows: input.status === 'ok' ? input.rows : 0,
    matched: rows.length,
    raw_key,
    fetched_at: input.fetched_at,
    recorded_at: now.toISOString(),
  })
  return { recorded: true, candidates: rows.length, duplicates, rejected }
}

const NEWSROOM_URLS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.values(NEWSROOM_OF).map((r) => [r.id, r.url({ now: new Date(0), newest: null })]),
)

async function insertSearch(db: PipelineDb, row: SearchRow): Promise<void> {
  await db.insert(tables.trackRecordSearches).values(row)
}

type CandidateRow = typeof tables.trackRecordCandidates.$inferInsert

const CANDIDATE_COLUMNS = 12

async function insertCandidates(db: PipelineDb, rows: readonly CandidateRow[]): Promise<void> {
  for (const part of chunk(rows, Math.floor(D1_MAX_BOUND_PARAMS / CANDIDATE_COLUMNS))) {
    await db.insert(tables.trackRecordCandidates).values(part).onConflictDoNothing()
  }
}
