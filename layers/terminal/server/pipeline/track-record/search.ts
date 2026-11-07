// Find candidates for each material alert: the GDELT articles and the lab's
// own newsroom posts within WINDOW_DAYS either side of when the terminal saw
// the change, matched on terms built from the cited change rows (terms.ts).
// Candidates only: the judge decides which are the same event (review.ts).
// Both sides are matched once, by the */5 cron (runTrackRecordSearch), when
// an alert's window has closed.
//
// The newsroom side reads posts the poll already stored.
//
// The press side reads GDELT's 15-minute GKG files (gkg.ts), each once, in
// order, off the Worker: an Actions job (scripts/gdelt-search.ts) asks
// /api/gdelt/work for the next unread files and the vocabulary (gkgWork),
// reads each file, and posts its row count and the rows carrying a
// vocabulary word to /api/gdelt/file (recordGkgFile), which keeps them
// (mentions.ts). Once every file through an alert's window has been read,
// the cron matches the alert against the rows kept for its window, earliest
// first, and writes the side's search row. Its window_start says where the
// search actually began (mentions.ts › pressSearchedFrom), and the page
// leaves a window searched only in part out of the lead/lag tally.
//
// GDELT's search API was used before (rows with a DOC API source_url). It
// limits requests per IP and answered most queries with a 429 from every IP
// we tried.

import { and, asc, count, eq, gte, inArray, max } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { ChangeRow, contentHash } from '../contracts'
import { D1_MAX_BOUND_PARAMS, chunk, type PipelineDb } from '../store'
import { NEWSROOM_OF } from '../../theses/recipes/newsrooms'
import {
  GKG_BASE,
  GKG_FROM,
  GKG_READY_MS,
  GKG_SLOT_MS,
  gkgSlots,
  gkgStamp,
  gkgUrl,
  stampIso,
} from './gkg'
import {
  acceptedMentions,
  mentionsIn,
  pressSearchedFrom,
  pruneMentions,
  retentionVocabulary,
  storeMentions,
  type GkgMention,
} from './mentions'
import { alertTerms, matchesArticle, matchesWhat, termList, type SearchTerms } from './terms'
import { TRACK_RECORD_FROM, sawIt, searchState, trackWindow, type TrackWindow } from './window'

export const MATERIAL_SEVERITIES = ['notable', 'critical'] as const

/** GKG files handed out per /api/gdelt/work call: about two minutes of the job's reading. */
export const GKG_FILES_PER_CALL = 24

/** Newsroom posts kept per alert, earliest first. */
export const NEWSROOM_CANDIDATE_LIMIT = 10

/** Articles kept per alert: the earliest ones, since the first report is the one that counts. */
export const PRESS_CANDIDATE_LIMIT = 20

/** One key per headline: a wire story syndicated to fifty sites is one report, first seen at its earliest copy. */
export const titleKey = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

export interface AlertForSearch {
  id: string
  created_at: string
  changes: ChangeRow[]
}

/** Notable and critical alerts since TRACK_RECORD_FROM, oldest first, with their cited rows. */
export async function materialAlerts(db: PipelineDb): Promise<AlertForSearch[]> {
  const alerts = await db
    .select({
      id: tables.alerts.id,
      created_at: tables.alerts.created_at,
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
  status: 'ok' | 'skipped'
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

/** The last GKG file read, ok or missing; files are read as a contiguous run from GKG_FROM. */
async function lastReadStamp(db: PipelineDb): Promise<string | null> {
  const [row] = await db.select({ stamp: max(tables.gdeltFiles.stamp) }).from(tables.gdeltFiles)
  return row?.stamp ?? null
}

/** The quarter hour after `last`, or GKG_FROM's when nothing has been read. */
const nextAfter = (last: string | null) =>
  last ? gkgStamp(Date.parse(stampIso(last)) + GKG_SLOT_MS) : gkgStamp(Date.parse(GKG_FROM))

/** The quarter hours whose file is due and not read yet, oldest first. */
export function unreadStamps(now: Date, last: string | null): string[] {
  return gkgSlots(now, stampIso(nextAfter(last)))
}

/** The oldest file that is due and not read yet, or null when the job is caught up. */
export async function oldestUnread(db: PipelineDb, now: Date): Promise<string | null> {
  const next = nextAfter(await lastReadStamp(db))
  return Date.parse(stampIso(next)) + GKG_READY_MS <= now.getTime() ? next : null
}

/**
 * Whether every GKG file a window needs has been read: the one whose quarter
 * hour holds the window's end, and so (the run being contiguous) every one
 * before it.
 */
export function windowRead(window: TrackWindow, lastRead: string | null): boolean {
  return lastRead !== null && Date.parse(stampIso(lastRead)) + GKG_SLOT_MS > Date.parse(window.end)
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
 * side, the GDELT side once every file in the window has been read, and a
 * skip for an alert with no search terms. Never fetches anything.
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
  const lastRead = await lastReadStamp(db)
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

    if (!p.gdeltDone && windowRead(p.window, lastRead)) {
      const rows = await pressCandidates(db, p.alert.id, p.terms, p.window, searched_at)
      // Candidates before the search row: a run that dies between the two
      // matches again next tick, and the candidate ids make that a no-op.
      await insertCandidates(db, rows)
      await insertSearch(db, {
        ...base,
        window_start: await pressSearchedFrom(db, p.terms, p.window, now),
        id: crypto.randomUUID(),
        source: 'gdelt',
        query: termList(p.terms),
        status: 'ok',
        detail: null,
        candidates: (counts.get(p.alert.id) ?? 0) + rows.length,
        raw_key: null,
        source_url: GKG_BASE,
      })
      report.gdelt++
      report.candidates += rows.length
    }
  }
  return report
}

/**
 * The kept GKG rows in an alert's window that match its terms, earliest
 * first, one per headline, up to PRESS_CANDIDATE_LIMIT. Press candidates the
 * alert already holds count toward both: alerts whose windows were open when
 * the job still matched each file as it read it have some.
 */
async function pressCandidates(
  db: PipelineDb,
  alertId: string,
  terms: SearchTerms,
  window: TrackWindow,
  found_at: string,
): Promise<CandidateRow[]> {
  const held = await db
    .select({ id: tables.trackRecordCandidates.id, title: tables.trackRecordCandidates.title })
    .from(tables.trackRecordCandidates)
    .where(
      and(
        eq(tables.trackRecordCandidates.alert_id, alertId),
        eq(tables.trackRecordCandidates.kind, 'press'),
      ),
    )
  const ids = new Set(held.map((c) => c.id))
  const titles = new Set(held.map((c) => titleKey(c.title)))
  const out: CandidateRow[] = []
  if (ids.size >= PRESS_CANDIDATE_LIMIT) return out
  for await (const m of mentionsIn(db, window)) {
    if (!matchesArticle(m, terms)) continue
    const id = candidateId(alertId, 'press', m.url)
    const key = titleKey(m.title)
    if (ids.has(id) || titles.has(key)) continue
    ids.add(id)
    titles.add(key)
    out.push({
      id,
      alert_id: alertId,
      kind: 'press',
      title: m.title,
      snippet: null,
      outlet: m.outlet,
      url: m.url,
      published_at: m.seen_at,
      search_id: `gkg:${m.stamp}`,
      found_at,
      source_url: gkgUrl(m.stamp),
      fetched_at: m.fetched_at,
    })
    if (ids.size >= PRESS_CANDIDATE_LIMIT) break
  }
  return out
}

export interface GkgWork {
  files: { stamp: string; url: string }[]
  /** The words a row must carry to be posted as a mention (mentions.ts). */
  vocabulary: string[]
}

/** The next unread GKG files, oldest first, and the vocabulary to keep their rows by. */
export async function gkgWork(
  db: PipelineDb,
  now: Date,
  limit: number = GKG_FILES_PER_CALL,
): Promise<GkgWork> {
  const stamps = unreadStamps(now, await lastReadStamp(db)).slice(0, limit)
  if (stamps.length === 0) return { files: [], vocabulary: [] }
  return {
    files: stamps.map((stamp) => ({ stamp, url: gkgUrl(stamp) })),
    vocabulary: await retentionVocabulary(db),
  }
}

export interface GkgFileInput {
  stamp: string
  /** When the job downloaded the file. */
  fetched_at: string
  /** missing: GDELT answered 404, it never published that quarter hour. */
  status: 'ok' | 'missing'
  /** Rows the file held. */
  rows: number
  /** Every row carrying a vocabulary word, compacted. */
  mentions: GkgMention[]
}

export type GkgFileOutcome =
  | { recorded: true; mentions: number; rejected: number }
  | { recorded: false; reason: 'not-next' }

/**
 * Store one GKG file the job read: its row, and the rows it carried that name
 * a vocabulary word (mentions.ts), with the vocabulary they were kept by.
 * Only for the next file in the run, once it is due, so the files read are a
 * contiguous run from GKG_FROM and the last one read says what has been. The
 * vocabulary is the Worker's own as the file is recorded: a posted row is
 * kept with the names in it, and a row with none is counted as rejected.
 */
export async function recordGkgFile(
  db: PipelineDb,
  input: GkgFileInput,
  now: Date,
): Promise<GkgFileOutcome> {
  const next = nextAfter(await lastReadStamp(db))
  const due = Date.parse(stampIso(next)) + GKG_READY_MS <= now.getTime()
  if (input.stamp !== next || !due) return { recorded: false, reason: 'not-next' }

  const ok = input.status === 'ok'
  const vocabulary = ok ? await retentionVocabulary(db) : null
  const kept = vocabulary ? acceptedMentions(input.mentions, vocabulary) : []
  await storeMentions(db, input.stamp, input.fetched_at, kept)
  await pruneMentions(db, now)
  await db.insert(tables.gdeltFiles).values({
    stamp: input.stamp,
    url: gkgUrl(input.stamp),
    status: input.status,
    rows: ok ? input.rows : 0,
    matched: 0,
    raw_key: null,
    fetched_at: input.fetched_at,
    recorded_at: now.toISOString(),
    mentions: kept.length,
    vocabulary: vocabulary ? JSON.stringify(vocabulary) : null,
  })
  return { recorded: true, mentions: kept.length, rejected: input.mentions.length - kept.length }
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
