// One run of the print reader, hourly (tasks/prints/read.ts):
//
//   1. the feeds (PRINT_FEEDS): the exchange's monthly revenue feed (TWSE
//      OpenAPI t187ap05_L, the newest month for every listed company) and
//      Accton's own revenue page (40 months). A set of figures we haven't
//      held is stored in R2 once, with its body; its rows go through storeObservations, so a month
//      first appears the hour the feed first carries it.
//   2. TSMC's revenue 6-Ks on EDGAR: each 6-K filed in the first twelve days
//      of a month since 2015, read once, oldest first, at most TSMC_DOCS_PER_RUN
//      a run. Oldest first keeps each vintage chain in release order, so the
//      first backfill takes about a day of runs; after it, each new report is
//      read within the hour. A 6-K that isn't a revenue report is kept as
//      `other` and never fetched again; a failed one is retried after a day.
//
// Each step's failure is spooled as one ops event and the other step still runs.

import { and, eq, inArray } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { recordOpsEvent } from '#server/utils/ops'
import type { SourceFetcher } from '../pipeline/fetch'
import type { RawStore } from '../pipeline/refresh'
import type { PipelineDb } from '../pipeline/store'
import {
  parseAcctonRevenue,
  parseTsmcRevenue6k,
  parseTwseRevenue,
  TSMC_CIK,
  tsmcCandidates,
  type PrintObservation,
} from './parse'
import { storeObservations } from './store'

export const KIND_PRINT_READ_FAILED = 'print_read_failed'

export const TWSE_REVENUE = {
  source_id: 'twse-monthly-revenue',
  url: 'https://openapi.twse.com.tw/v1/opendata/t187ap05_L',
} as const

export const ACCTON_REVENUE = {
  source_id: 'accton-monthly-revenue',
  url: 'https://www.accton.com/monthly-merge/',
} as const

export const TSMC_6K = {
  source_id: 'tsmc-revenue-6k',
  submissions: `https://data.sec.gov/submissions/CIK${TSMC_CIK}.json`,
} as const

export const TSMC_DOCS_PER_RUN = 20
export const FAILED_RETRY_MS = 86_400_000
export const LIVE_WINDOW_MS = 2 * 86_400_000

export interface PrintDeps {
  raw: RawStore
  fetcher: SourceFetcher
  now: Date
}

export interface FeedReport {
  status: string
  added: number
  revised: number
}

export interface PrintReadReport {
  feeds: Record<string, FeedReport>
  tsmc: { read: number; reports: number; added: number; revised: number; pending: number }
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function fail(db: PipelineDb, detail: string): Promise<void> {
  await recordOpsEvent(db, { kind: KIND_PRINT_READ_FAILED, detail })
}

/** A page or feed that states its whole history (or its newest month) in one body. */
export interface PrintFeed {
  source_id: string
  url: string
  ext: 'json' | 'html'
  parse: (body: string) => PrintObservation[]
}

export const PRINT_FEEDS: readonly PrintFeed[] = [
  { ...TWSE_REVENUE, ext: 'json', parse: parseTwseRevenue },
  { ...ACCTON_REVENUE, ext: 'html', parse: parseAcctonRevenue },
]

/**
 * One read of a feed. Figures we have read before store nothing. A source's
 * first read is the backfill: what it held then was printed before we looked,
 * so its first_seen_at is our read, not the release.
 */
export async function readFeed(
  db: PipelineDb,
  deps: PrintDeps,
  feed: PrintFeed,
): Promise<FeedReport> {
  const fetched_at = deps.now.toISOString()
  const res = await deps.fetcher({ source_id: feed.source_id, url: feed.url, ext: feed.ext })
  if (!res.ok) {
    await fail(db, `${feed.source_id}: ${res.detail}`)
    return { status: 'failed', added: 0, revised: 0 }
  }
  let observations
  try {
    observations = feed.parse(res.text)
  } catch (error) {
    await fail(db, `${feed.source_id}: ${String(error)}`)
    return { status: 'unparsed', added: 0, revised: 0 }
  }
  // Keyed on the figures, not the bytes: the exchange restamps its table date
  // every day, and a page's markup moves without its numbers moving.
  const hash = await sha256(JSON.stringify(observations))
  const doc_id = `${feed.source_id}:${hash}`
  const raw_key = `prints/${feed.source_id}/${hash.slice(0, 16)}.${feed.ext}`
  const [seen] = await db
    .select({ doc_id: tables.printDocuments.doc_id })
    .from(tables.printDocuments)
    .where(eq(tables.printDocuments.doc_id, doc_id))
  if (seen) return { status: 'unchanged', added: 0, revised: 0 }
  const [held] = await db
    .select({ id: tables.hardwarePrints.id })
    .from(tables.hardwarePrints)
    .where(eq(tables.hardwarePrints.source_id, feed.source_id))
    .limit(1)
  await deps.raw.put(raw_key, res.text, feed.ext === 'json' ? 'application/json' : 'text/html')
  const stored = await storeObservations(db, observations, {
    source_id: feed.source_id,
    source_url: feed.url,
    fetched_at,
    raw_key,
    basis: held ? 'live' : 'backfill',
  })
  await db.insert(tables.printDocuments).values({
    doc_id,
    source_id: feed.source_id,
    filed: fetched_at.slice(0, 10),
    status: 'read',
    detail: null,
    raw_key,
    source_url: feed.url,
    fetched_at,
  })
  return { status: 'read', ...stored }
}

export async function readTsmc6k(
  db: PipelineDb,
  deps: PrintDeps,
): Promise<PrintReadReport['tsmc']> {
  const report = { read: 0, reports: 0, added: 0, revised: 0, pending: 0 }
  const sub = await deps.fetcher({
    source_id: `${TSMC_6K.source_id}-submissions`,
    url: TSMC_6K.submissions,
    ext: 'json',
  })
  if (!sub.ok) {
    await fail(db, `${TSMC_6K.source_id}: submissions ${sub.detail}`)
    return report
  }
  let candidates
  try {
    candidates = tsmcCandidates(sub.text)
  } catch (error) {
    await fail(db, `${TSMC_6K.source_id}: ${String(error)}`)
    return report
  }
  const ids = candidates.map((c) => c.accession_no)
  const stored = new Map<string, { status: string; fetched_at: string }>()
  for (let i = 0; i < ids.length; i += 90) {
    for (const d of await db
      .select({
        doc_id: tables.printDocuments.doc_id,
        status: tables.printDocuments.status,
        fetched_at: tables.printDocuments.fetched_at,
      })
      .from(tables.printDocuments)
      .where(
        and(
          eq(tables.printDocuments.source_id, TSMC_6K.source_id),
          inArray(tables.printDocuments.doc_id, ids.slice(i, i + 90)),
        ),
      ))
      stored.set(d.doc_id, d)
  }
  const due = candidates
    .filter((c) => {
      const s = stored.get(c.accession_no)
      if (!s) return true
      return (
        s.status === 'failed' && deps.now.getTime() - Date.parse(s.fetched_at) > FAILED_RETRY_MS
      )
    })
    .reverse() // oldest first: release order
  report.pending = Math.max(0, due.length - TSMC_DOCS_PER_RUN)

  for (const c of due.slice(0, TSMC_DOCS_PER_RUN)) {
    const fetched_at = new Date().toISOString()
    const res = await deps.fetcher({ source_id: TSMC_6K.source_id, url: c.url, ext: 'html' })
    report.read++
    const doc = {
      doc_id: c.accession_no,
      source_id: TSMC_6K.source_id,
      filed: c.filed,
      source_url: c.url,
      fetched_at,
    }
    if (!res.ok) {
      await upsertDoc(db, { ...doc, status: 'failed', detail: res.detail, raw_key: null })
      if (res.status === 429) {
        await fail(db, `${TSMC_6K.source_id}: HTTP 429`)
        break
      }
      continue
    }
    let observations
    try {
      observations = parseTsmcRevenue6k(res.text, c.accepted_at)
    } catch (error) {
      await upsertDoc(db, { ...doc, status: 'failed', detail: String(error), raw_key: null })
      await fail(db, `${TSMC_6K.source_id} ${c.accession_no}: ${String(error)}`)
      continue
    }
    if (!observations) {
      await upsertDoc(db, { ...doc, status: 'other', detail: null, raw_key: null })
      continue
    }
    const raw_key = `prints/tsmc/${c.accession_no}.htm`
    await deps.raw.put(raw_key, res.text, 'text/html')
    // Read within two days of its acceptance: a live read. Anything later is the backfill.
    const live = deps.now.getTime() - Date.parse(c.accepted_at) < LIVE_WINDOW_MS
    const added = await storeObservations(db, observations, {
      source_id: TSMC_6K.source_id,
      source_url: c.url,
      fetched_at,
      raw_key,
      basis: live ? 'live' : 'backfill',
    })
    await upsertDoc(db, { ...doc, status: 'read', detail: null, raw_key })
    report.reports++
    report.added += added.added
    report.revised += added.revised
  }
  return report
}

async function upsertDoc(
  db: PipelineDb,
  row: typeof tables.printDocuments.$inferInsert,
): Promise<void> {
  await db
    .insert(tables.printDocuments)
    .values(row)
    .onConflictDoUpdate({
      target: tables.printDocuments.doc_id,
      set: {
        status: row.status,
        detail: row.detail,
        raw_key: row.raw_key,
        fetched_at: row.fetched_at,
      },
    })
}

export async function runPrintReads(db: PipelineDb, deps: PrintDeps): Promise<PrintReadReport> {
  const feeds: Record<string, FeedReport> = {}
  for (const feed of PRINT_FEEDS) {
    feeds[feed.source_id] = await readFeed(db, deps, feed).catch(async (error: unknown) => {
      await fail(db, `${feed.source_id}: ${String(error)}`)
      return { status: 'threw', added: 0, revised: 0 }
    })
  }
  const tsmc = await readTsmc6k(db, deps).catch(async (error: unknown) => {
    await fail(db, `${TSMC_6K.source_id}: ${String(error)}`)
    return { read: 0, reports: 0, added: 0, revised: 0, pending: -1 }
  })
  return { feeds, tsmc }
}
