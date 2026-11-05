// Find candidates for each material alert once its window has closed: the
// GDELT articles and the lab's own newsroom posts within WINDOW_DAYS either
// side of when the terminal saw the change, matched on terms built from the
// cited change rows (terms.ts). Candidates only: the judge decides which are
// the same event (review.ts).
//
// Runs on the */5 cron with one GDELT query per run. GDELT asks for one
// query every 5 seconds and answers a burst with minutes of 429s, so a slow
// steady drip clears a backlog of a hundred alerts in under nine hours. A 429
// ends the run and the next one retries. An alert is searched once its
// window has closed, so both sides of it are in; until then the page says
// the window is open.

import { and, asc, desc, gte, inArray } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { recordOpsEvent } from '#server/utils/ops'
import { ChangeRow, contentHash, contentHashOfText } from '../contracts'
import { RATE_LIMITED_DETAIL, type SourceFetcher } from '../fetch'
import type { RawStore } from '../refresh'
import { D1_MAX_BOUND_PARAMS, chunk, type PipelineDb } from '../store'
import { NEWSROOM_OF } from '../../theses/recipes/newsrooms'
import {
  GDELT_HORIZON_DAYS,
  GDELT_SPACING_MS,
  gdeltUrl,
  parseGdeltArticles,
  type PressArticle,
} from './gdelt'
import { alertTerms, gdeltQuery, matchesWhat, type SearchTerms } from './terms'
import { TRACK_RECORD_FROM, sawIt, searchState, trackWindow, type TrackWindow } from './window'

export const MATERIAL_SEVERITIES = ['notable', 'critical'] as const

/** GDELT queries per run. */
export const SEARCHES_PER_RUN = 1

/**
 * Failed GDELT searches after which an alert stops being retried. A 429 is
 * not one: it says GDELT was busy (Workers share egress IPs, so its
 * per-IP limit trips on other tenants' traffic too), not that the query is
 * bad, and counting it abandoned the oldest alert after three busy ticks.
 */
export const MAX_FAILED_SEARCHES = 3

/** A failed search that GDELT refused with a 429: retried, never counted toward giving up. */
export function rateLimitedSearch(s: { status: string; detail: string | null }): boolean {
  return s.status === 'failed' && (s.detail?.startsWith(RATE_LIMITED_DETAIL) ?? false)
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
  raw: RawStore
  fetcher: SourceFetcher
  now: () => Date
  sleep?: (ms: number) => Promise<void>
  limit?: number
}

export interface SearchRunReport {
  searched: number
  candidates: number
  failed: { alert_id: string; detail: string }[]
  /** True when GDELT answered 429 and the run stopped early. */
  rate_limited: boolean
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

/** Search every alert that is due, up to `limit` GDELT queries. */
export async function runTrackRecordSearch(
  db: PipelineDb,
  deps: SearchDeps,
): Promise<SearchRunReport> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const limit = deps.limit ?? SEARCHES_PER_RUN
  const report: SearchRunReport = { searched: 0, candidates: 0, failed: [], rate_limited: false }

  const [alerts, searches] = await Promise.all([materialAlerts(db), searchesOf(db)])
  const done = new Set<string>()
  const failures = new Map<string, number>()
  for (const s of searches) {
    const key = `${s.alert_id}:${s.source}`
    if (s.status === 'ok' || s.status === 'skipped') done.add(key)
    else if (!rateLimitedSearch(s)) failures.set(key, (failures.get(key) ?? 0) + 1)
  }

  let queried = 0
  for (const alert of alerts) {
    if (queried >= limit) break
    const saw = sawIt(alert.changes)
    if (!saw) continue
    const window = trackWindow(saw.at)
    const state = searchState(window, deps.now())
    if (state === 'open') continue
    const gdeltKey = `${alert.id}:gdelt`
    const newsroomKey = `${alert.id}:newsroom`
    if (done.has(gdeltKey) && done.has(newsroomKey)) continue
    if ((failures.get(gdeltKey) ?? 0) >= MAX_FAILED_SEARCHES && done.has(newsroomKey)) continue

    const terms = alertTerms(alert.changes)
    const searched_at = deps.now().toISOString()
    const base = {
      alert_id: alert.id,
      window_start: window.start,
      window_end: window.end,
      searched_at,
    }

    if (!terms) {
      // A ranking or other row with no press shape: nothing to search, said once.
      for (const source of ['gdelt', 'newsroom'] as const) {
        if (done.has(`${alert.id}:${source}`)) continue
        await insertSearch(db, {
          ...base,
          id: crypto.randomUUID(),
          source,
          query: '',
          status: 'skipped',
          detail: 'no search terms for the cited change types',
          candidates: 0,
          raw_key: null,
          source_url: source === 'gdelt' ? gdeltUrl('', window.start, window.end) : '',
        })
      }
      continue
    }

    if (!done.has(newsroomKey)) {
      const recipeIds = newsroomsFor(alert.changes)
      const posts = newsroomCandidates(await newsroomPosts(db, recipeIds, window), terms)
      const search_id = crypto.randomUUID()
      await insertSearch(db, {
        ...base,
        id: search_id,
        source: 'newsroom',
        query: terms.what.join(' | '),
        status: recipeIds.length ? 'ok' : 'skipped',
        detail: recipeIds.length ? null : 'no newsroom feed for this lab',
        candidates: posts.length,
        raw_key: null,
        source_url: recipeIds.map((id) => NEWSROOM_URLS[id] ?? id).join(' '),
      })
      await insertCandidates(
        db,
        posts.map((p) => ({
          id: candidateId(alert.id, 'newsroom', p.link),
          alert_id: alert.id,
          kind: 'newsroom',
          title: p.title,
          snippet: p.summary || null,
          outlet: hostOf(p.link),
          url: p.link,
          published_at: p.published_at,
          search_id,
          found_at: searched_at,
          source_url: p.source_url,
          fetched_at: p.fetched_at,
        })),
      )
      report.candidates += posts.length
    }

    if (done.has(gdeltKey) || (failures.get(gdeltKey) ?? 0) >= MAX_FAILED_SEARCHES) continue
    if (state === 'beyond-horizon') {
      await insertSearch(db, {
        ...base,
        id: crypto.randomUUID(),
        source: 'gdelt',
        query: gdeltQuery(terms),
        status: 'skipped',
        detail: `the window starts more than ${GDELT_HORIZON_DAYS} days ago, past what GDELT's DOC API searches`,
        candidates: 0,
        raw_key: null,
        source_url: gdeltUrl(gdeltQuery(terms), window.start, window.end),
      })
      continue
    }

    if (queried > 0) await sleep(GDELT_SPACING_MS)
    queried++
    const query = gdeltQuery(terms)
    const url = gdeltUrl(query, window.start, window.end)
    const fetched = await deps.fetcher({ source_id: 'gdelt-doc', url, ext: 'json' })
    const fetched_at = deps.now().toISOString()
    let articles: PressArticle[] | null = null
    let detail: string | null = null
    let raw_key: string | null = null
    if (!fetched.ok) {
      detail = fetched.detail
    } else {
      try {
        articles = parseGdeltArticles(fetched.text)
        raw_key = `track-record/gdelt/${contentHashOfText(fetched.text)}.json`
        await deps.raw.put(raw_key, fetched.text, 'application/json')
      } catch (error) {
        detail = `parse: ${String(error)}`
      }
    }
    const search_id = crypto.randomUUID()
    await insertSearch(db, {
      ...base,
      searched_at: fetched_at,
      id: search_id,
      source: 'gdelt',
      query,
      status: articles ? 'ok' : 'failed',
      detail: detail?.slice(0, 500) ?? null,
      candidates: articles?.length ?? 0,
      raw_key,
      source_url: url,
    })
    report.searched++
    if (!articles) {
      report.failed.push({ alert_id: alert.id, detail: detail ?? 'unknown' })
      if (!fetched.ok && fetched.status === 429) {
        report.rate_limited = true
        break
      }
      await recordOpsEvent(db, {
        kind: 'track_record_search_failed',
        detail: `GDELT search for alert ${alert.id}: ${detail}`,
      })
      continue
    }
    await insertCandidates(
      db,
      articles.map((a) => ({
        id: candidateId(alert.id, 'press', a.url),
        alert_id: alert.id,
        kind: 'press',
        title: a.title,
        snippet: null,
        outlet: a.outlet,
        url: a.url,
        published_at: a.seen_at,
        search_id,
        found_at: fetched_at,
        source_url: url,
        fetched_at,
      })),
    )
    report.candidates += articles.length
  }
  return report
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
