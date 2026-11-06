// Find candidates for each material alert once its window has closed: the
// GDELT articles and the lab's own newsroom posts within WINDOW_DAYS either
// side of when the terminal saw the change, matched on terms built from the
// cited change rows (terms.ts). Candidates only: the judge decides which are
// the same event (review.ts).
//
// The two sides run in different places. The newsroom side reads posts the
// poll already stored, so the */5 cron does it here (runTrackRecordSearch).
// The GDELT side does not run on Cloudflare at all: Workers share egress IPs,
// GDELT limits per IP, and from those IPs 85% of our queries drew a 429 for
// other tenants' traffic. A GitHub Actions job (scripts/gdelt-search.ts) asks
// /api/gdelt/pending for the due searches (dueGdeltSearches), queries GDELT
// itself at GDELT's own pace, and posts each answer to /api/gdelt/result
// (recordGdeltResult), which stores the bytes and the candidates exactly as
// the Worker's own fetch did. An alert is searched once its window has
// closed, so both sides of it are in; until then the page says the window is
// open.

import { and, asc, desc, gte, inArray } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { recordOpsEvent } from '#server/utils/ops'
import { ChangeRow, contentHash, contentHashOfText } from '../contracts'
import { RATE_LIMITED_DETAIL } from '../fetch'
import type { RawStore } from '../refresh'
import { D1_MAX_BOUND_PARAMS, chunk, type PipelineDb } from '../store'
import { NEWSROOM_OF } from '../../theses/recipes/newsrooms'
import { GDELT_HORIZON_DAYS, gdeltUrl, parseGdeltArticles, type PressArticle } from './gdelt'
import { alertTerms, gdeltQuery, matchesWhat, type SearchTerms } from './terms'
import { TRACK_RECORD_FROM, sawIt, searchState, trackWindow, type TrackWindow } from './window'

export const MATERIAL_SEVERITIES = ['notable', 'critical'] as const

/** GDELT searches handed out per /api/gdelt/pending call. */
export const GDELT_PENDING_LIMIT = 10

/**
 * Failed GDELT searches after which an alert stops being retried. A busy
 * GDELT is not one (transientSearch): a 429 or a timeout says GDELT had no
 * time for us, not that the query is bad, and counting those abandoned the
 * oldest alert after three busy ticks (24 of 105 alerts on 2026-11-05 for
 * 429s; one more on 2026-11-06 for timeouts).
 */
export const MAX_FAILED_SEARCHES = 3

/** The detail of a search GDELT did not answer in time. */
export const TIMEOUT_DETAIL = 'timeout'

/**
 * A failed search that says GDELT was busy, not that the query failed: a 429,
 * or no answer in time. Retried, never counted toward giving up, never mailed.
 * `TimeoutError` matches the rows the Worker's own fetcher wrote before the
 * search moved to GitHub Actions ("fetch threw: TimeoutError: ...").
 */
export function transientSearch(s: { status: string; detail: string | null }): boolean {
  if (s.status !== 'failed' || !s.detail) return false
  return (
    s.detail.startsWith(RATE_LIMITED_DETAIL) ||
    s.detail.startsWith(TIMEOUT_DETAIL) ||
    s.detail.includes('TimeoutError')
  )
}

/** Newsroom posts kept per alert, earliest first. */
export const NEWSROOM_CANDIDATE_LIMIT = 10

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
      detail: tables.trackRecordSearches.detail,
    })
    .from(tables.trackRecordSearches)
    .orderBy(desc(tables.trackRecordSearches.searched_at))
}

export interface SearchDeps {
  now: () => Date
}

export interface SearchRunReport {
  /** Newsroom searches written this run. */
  newsroom: number
  /** Searches recorded as skipped: no terms, or a window past GDELT's horizon. */
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
  state: 'due' | 'beyond-horizon'
  terms: SearchTerms | null
  gdeltDone: boolean
  newsroomDone: boolean
  /** MAX_FAILED_SEARCHES real failures: GDELT is not asked again. */
  gdeltGivenUp: boolean
}

/** Every material alert whose window has closed, oldest first, with what is left to do. */
async function closedAlerts(db: PipelineDb, now: Date): Promise<AlertPlan[]> {
  const [alerts, searches] = await Promise.all([materialAlerts(db), searchesOf(db)])
  const done = new Set<string>()
  const failures = new Map<string, number>()
  for (const s of searches) {
    const key = `${s.alert_id}:${s.source}`
    if (s.status === 'ok' || s.status === 'skipped') done.add(key)
    else if (!transientSearch(s)) failures.set(key, (failures.get(key) ?? 0) + 1)
  }
  const plans: AlertPlan[] = []
  for (const alert of alerts) {
    const saw = sawIt(alert.changes)
    if (!saw) continue
    const window = trackWindow(saw.at)
    const state = searchState(window, now)
    if (state === 'open') continue
    plans.push({
      alert,
      window,
      state,
      terms: alertTerms(alert.changes),
      gdeltDone: done.has(`${alert.id}:gdelt`),
      newsroomDone: done.has(`${alert.id}:newsroom`),
      gdeltGivenUp: (failures.get(`${alert.id}:gdelt`) ?? 0) >= MAX_FAILED_SEARCHES,
    })
  }
  return plans
}

const baseOf = (p: AlertPlan, searched_at: string) => ({
  alert_id: p.alert.id,
  window_start: p.window.start,
  window_end: p.window.end,
  searched_at,
})

/**
 * The cron's half: the newsroom side of every closed alert, and the GDELT
 * side's skips (no search terms, or a window past GDELT's horizon). Never
 * fetches anything; the GDELT queries are the Actions job's.
 */
export async function runTrackRecordSearch(
  db: PipelineDb,
  deps: SearchDeps,
): Promise<SearchRunReport> {
  const report: SearchRunReport = { newsroom: 0, skipped: 0, candidates: 0 }
  for (const p of await closedAlerts(db, deps.now())) {
    if (p.gdeltDone && p.newsroomDone) continue
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
          source_url: source === 'gdelt' ? gdeltUrl('', p.window.start, p.window.end) : '',
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

    if (!p.gdeltDone && !p.gdeltGivenUp && p.state === 'beyond-horizon') {
      const query = gdeltQuery(p.terms)
      await insertSearch(db, {
        ...base,
        id: crypto.randomUUID(),
        source: 'gdelt',
        query,
        status: 'skipped',
        detail: `the window starts more than ${GDELT_HORIZON_DAYS} days ago, past what GDELT's DOC API searches`,
        candidates: 0,
        raw_key: null,
        source_url: gdeltUrl(query, p.window.start, p.window.end),
      })
      report.skipped++
    }
  }
  return report
}

export interface DueGdeltSearch {
  alert_id: string
  query: string
  /** The exact URL to fetch; /api/gdelt/result refuses an answer for any other. */
  url: string
  window_start: string
  window_end: string
}

/** The GDELT searches due now, oldest alert first: what the Actions job asks GDELT. */
export async function dueGdeltSearches(
  db: PipelineDb,
  now: Date,
  limit: number = GDELT_PENDING_LIMIT,
): Promise<DueGdeltSearch[]> {
  const due: DueGdeltSearch[] = []
  for (const p of await closedAlerts(db, now)) {
    if (due.length >= limit) break
    if (p.state !== 'due' || !p.terms || p.gdeltDone || p.gdeltGivenUp) continue
    const query = gdeltQuery(p.terms)
    due.push({
      alert_id: p.alert.id,
      query,
      url: gdeltUrl(query, p.window.start, p.window.end),
      window_start: p.window.start,
      window_end: p.window.end,
    })
  }
  return due
}

/** What the Actions job saw when it fetched a due search's URL. */
export type GdeltAnswer =
  | { kind: 'http'; status: number; text: string }
  | { kind: 'timeout' }
  | { kind: 'error'; message: string }

export interface GdeltResultInput {
  alert_id: string
  url: string
  fetched_at: string
  answer: GdeltAnswer
}

export type GdeltResultOutcome =
  | { recorded: true; status: 'ok' | 'failed'; transient: boolean; candidates: number }
  | { recorded: false; reason: 'not-due' | 'url-mismatch' }

/**
 * Store one GDELT answer the Actions job fetched: the search row, the raw
 * bytes in R2, and the articles as press candidates — the same rows the
 * Worker's own fetch wrote. Only for a search that is due, at the URL
 * dueGdeltSearches handed out, so the job can neither pick the query nor
 * fill a side that is done.
 */
export async function recordGdeltResult(
  db: PipelineDb,
  raw: RawStore,
  input: GdeltResultInput,
  now: Date,
): Promise<GdeltResultOutcome> {
  const due = (await dueGdeltSearches(db, now, Number.POSITIVE_INFINITY)).find(
    (d) => d.alert_id === input.alert_id,
  )
  if (!due) return { recorded: false, reason: 'not-due' }
  if (due.url !== input.url) return { recorded: false, reason: 'url-mismatch' }

  const { answer, fetched_at } = input
  let articles: PressArticle[] | null = null
  let detail: string | null = null
  let raw_key: string | null = null
  if (answer.kind === 'timeout') {
    detail = `${TIMEOUT_DETAIL}: GDELT did not answer in time`
  } else if (answer.kind === 'error') {
    detail = `fetch threw: ${answer.message}`
  } else if (answer.status === 429) {
    detail = RATE_LIMITED_DETAIL
  } else if (answer.status < 200 || answer.status >= 300) {
    detail = `HTTP ${answer.status}`
  } else {
    try {
      articles = parseGdeltArticles(answer.text)
      raw_key = `track-record/gdelt/${contentHashOfText(answer.text)}.json`
      await raw.put(raw_key, answer.text, 'application/json')
    } catch (error) {
      articles = null
      detail = `parse: ${String(error)}`
    }
  }

  const search_id = crypto.randomUUID()
  const status = articles ? 'ok' : 'failed'
  const row: SearchRow = {
    id: search_id,
    alert_id: due.alert_id,
    source: 'gdelt',
    query: due.query,
    window_start: due.window_start,
    window_end: due.window_end,
    status,
    detail: detail?.slice(0, 500) ?? null,
    candidates: articles?.length ?? 0,
    searched_at: fetched_at,
    raw_key,
    source_url: due.url,
  }
  await insertSearch(db, row)
  const transient = transientSearch(row)
  if (!articles) {
    if (!transient) {
      await recordOpsEvent(db, {
        kind: 'track_record_search_failed',
        detail: `GDELT search for alert ${due.alert_id}: ${detail}`,
      })
    }
    return { recorded: true, status: 'failed', transient, candidates: 0 }
  }
  await insertCandidates(
    db,
    articles.map((a) => ({
      id: candidateId(due.alert_id, 'press', a.url),
      alert_id: due.alert_id,
      kind: 'press',
      title: a.title,
      snippet: null,
      outlet: a.outlet,
      url: a.url,
      published_at: a.seen_at,
      search_id,
      found_at: fetched_at,
      source_url: due.url,
      fetched_at,
    })),
  )
  return { recorded: true, status: 'ok', transient: false, candidates: articles.length }
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
