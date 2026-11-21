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
//   4. UN Comtrade (comtrade.ts): getDA once a run, then each Korea month that
//      is new or whose lastReleased moved, oldest first, one preview call
//      each, at most COMTRADE_PERIODS_PER_RUN a run, COMTRADE_SPACING_MS
//      apart (the keyless API answers 429 to a second call within a second).
//      The first backfill of 156 months takes about seven runs.
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
import {
  kcsAttachments,
  kcsBoardUrl,
  KCS_PAGE_SIZE,
  kcsRelease,
  kcsReleaseUrl,
  kcsTextsUrl,
  kcsViewerUrl,
  parseKcsBoard,
  parseKcsChipExports,
  parseKcsReleasePage,
  parseKcsViewer,
  hasFigures,
} from './kcs'
import {
  COMTRADE,
  comtradeAvailabilityUrl,
  comtradePreviewUrl,
  parseComtradeAvailability,
  parseComtradePreview,
} from './comtrade'
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

/**
 * Korea Customs Service's releases. The reader logs every release it lists
 * under `reader`; a release's figures are stored under `marked` when its page
 * carries KOGL Type 1 and under `unmarked` when it carries no licence mark,
 * so the rights split is per release (sources.yaml › print_sources).
 */
export const KCS = {
  reader: 'kcs-chip-exports',
  marked: 'kcs-chip-exports',
  unmarked: 'kcs-chip-exports-unmarked',
} as const

export const TSMC_DOCS_PER_RUN = 20
/** Three GETs a release on a slow host: the first backfill takes about a day and a half of runs. */
export const KCS_DOCS_PER_RUN = 12
/**
 * Wall time a run spends on releases. KCS answers in a second or two but has
 * taken over 30, and prints:read shares its invocation with other tasks.
 */
export const KCS_RUN_BUDGET_MS = 4 * 60_000
/** Board pages read a run until the whole board is held (about 24 pages). */
export const KCS_BOARD_PAGES_PER_RUN = 4
/** The print_documents row that holds the board backfill's next page, or `listed` once done. */
export const KCS_BOARD_DOC = 'kcs:board'
export const COMTRADE_PERIODS_PER_RUN = 24
export const COMTRADE_SPACING_MS = 1_500
export const FAILED_RETRY_MS = 86_400_000
export const LIVE_WINDOW_MS = 2 * 86_400_000

export interface PrintDeps {
  raw: RawStore
  fetcher: SourceFetcher
  now: Date
  /** Waits between Comtrade calls; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>
}

export interface FeedReport {
  status: string
  added: number
  revised: number
}

export interface KcsReport {
  /** Board pages read this run, and whether the whole board is now held. */
  pages: number
  board: 'listing' | 'listed'
  read: number
  /** Releases that gave a chip figure, by licence mark. */
  marked: number
  unmarked: number
  added: number
  revised: number
  pending: number
}

export interface ComtradeReport {
  /** Months getDA lists from 2013 on. */
  listed: number
  read: number
  added: number
  revised: number
  pending: number
}

export interface PrintReadReport {
  feeds: Record<string, FeedReport>
  tsmc: { read: number; reports: number; added: number; revised: number; pending: number }
  kcs: KcsReport
  comtrade: ComtradeReport
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

/**
 * Lists the board, then reads the releases due. Until the whole board is
 * held no release is read, so the backfill reads in release order and a
 * month's provisional figure (the 1st) is its first vintage, the confirmed
 * one (about the 15th) the next.
 */
export async function readKcs(db: PipelineDb, deps: PrintDeps): Promise<KcsReport> {
  const report: KcsReport = {
    pages: 0,
    board: 'listing',
    read: 0,
    marked: 0,
    unmarked: 0,
    added: 0,
    revised: 0,
    pending: 0,
  }
  const started = Date.now()
  const docs = tables.printDocuments
  const fetched_at = deps.now.toISOString()
  const [state] = await db
    .select({ status: docs.status, detail: docs.detail })
    .from(docs)
    .where(eq(docs.doc_id, KCS_BOARD_DOC))
  let listed = state?.status === 'listed'
  let next = listed ? 0 : Number(state?.detail ?? 2)
  const pages = listed
    ? [1]
    : [1, ...Array.from({ length: KCS_BOARD_PAGES_PER_RUN - 1 }, (_, i) => next + i)]

  for (const page of pages) {
    const url = kcsBoardUrl(page)
    const res = await deps.fetcher({ source_id: KCS.reader, url, ext: 'html' })
    if (!res.ok) {
      await fail(db, `${KCS.reader}: board page ${page} ${res.detail}`)
      if (page === 1) return report
      break
    }
    const board = parseKcsBoard(res.text)
    report.pages++
    // Under D1's 100 bound parameters a statement: 8 columns, so 12 rows each.
    for (let i = 0; i < board.rows.length; i += 12) {
      await db
        .insert(docs)
        .values(
          board.rows.slice(i, i + 12).map((r) => ({
            doc_id: `kcs:${r.ntt_sn}`,
            source_id: KCS.reader,
            filed: r.posted,
            // A release of something else (the annual review, figures by
            // company size) is set aside without a fetch.
            status: kcsRelease(r.title, r.posted) ? 'listed' : 'other',
            detail: r.title,
            raw_key: null,
            source_url: kcsReleaseUrl(r.ntt_sn, r.ntt_url),
            fetched_at,
          })),
        )
        .onConflictDoNothing()
    }
    if (listed) continue
    if (page > 1) next = page + 1
    if (board.rows.length < KCS_PAGE_SIZE || page * KCS_PAGE_SIZE >= board.total) {
      listed = true
      break
    }
  }
  report.board = listed ? 'listed' : 'listing'
  await upsertDoc(db, {
    doc_id: KCS_BOARD_DOC,
    source_id: KCS.reader,
    filed: fetched_at.slice(0, 10),
    status: report.board,
    detail: listed ? null : String(next),
    raw_key: null,
    source_url: kcsBoardUrl(1),
    fetched_at,
  })
  if (!listed) return report

  const due = (
    await db
      .select({
        doc_id: docs.doc_id,
        status: docs.status,
        filed: docs.filed,
        detail: docs.detail,
        source_url: docs.source_url,
        fetched_at: docs.fetched_at,
      })
      .from(docs)
      .where(and(eq(docs.source_id, KCS.reader), inArray(docs.status, ['listed', 'failed'])))
  )
    .filter(
      (d) =>
        d.doc_id !== KCS_BOARD_DOC &&
        (d.status === 'listed' || deps.now.getTime() - Date.parse(d.fetched_at) > FAILED_RETRY_MS),
    )
    // Oldest first: release order. The board's ids rise with time.
    .sort(
      (a, b) =>
        a.filed.localeCompare(b.filed) || Number(a.doc_id.slice(4)) - Number(b.doc_id.slice(4)),
    )
  report.pending = Math.max(0, due.length - KCS_DOCS_PER_RUN)

  for (const d of due.slice(0, KCS_DOCS_PER_RUN)) {
    if (Date.now() - started > KCS_RUN_BUDGET_MS) break
    const ntt_sn = d.doc_id.slice(4)
    const title = d.detail ?? ''
    const release = kcsRelease(title, d.filed)
    const at = new Date().toISOString()
    // A failed release keeps its title, which is what says what it is for;
    // the error goes to the ops spool.
    const failed = (status = 'failed') =>
      upsertDoc(db, {
        doc_id: d.doc_id,
        source_id: KCS.reader,
        filed: d.filed,
        status,
        detail: title,
        raw_key: null,
        source_url: d.source_url,
        fetched_at: at,
      })
    if (!release) {
      await failed('other')
      continue
    }
    report.read++
    const page = await deps.fetcher({ source_id: KCS.reader, url: d.source_url, ext: 'html' })
    if (!page.ok) {
      await failed()
      if (page.status === 429) {
        await fail(db, `${KCS.reader}: HTTP 429`)
        break
      }
      continue
    }
    try {
      const parsed = parseKcsReleasePage(page.text)
      // The first attachment whose text kept its numbers. KCS sometimes posts
      // a release before its attachment: none is tried again tomorrow.
      let texts: string | null = null
      let reached = true
      for (const attachment of kcsAttachments(parsed)) {
        const viewer = await deps.fetcher({
          source_id: KCS.reader,
          url: kcsViewerUrl(attachment.file_key),
          ext: 'json',
        })
        const body = viewer.ok
          ? await deps.fetcher({
              source_id: KCS.reader,
              url: kcsTextsUrl(parseKcsViewer(viewer.text)),
              ext: 'txt',
            })
          : viewer
        if (!body.ok) {
          reached = false
          break
        }
        texts = body.text
        if (hasFigures(texts)) break
      }
      if (texts === null || !reached) {
        await failed()
        continue
      }
      const reading = parseKcsChipExports(texts, release)
      const source_id = parsed.kogl_type1 ? KCS.marked : KCS.unmarked
      const raw_key = `prints/kcs/${ntt_sn}.txt`
      // The page is kept with the text: its licence block is what put the rows on one side or the other.
      await deps.raw.put(`prints/kcs/${ntt_sn}.html`, page.text, 'text/html')
      await deps.raw.put(raw_key, texts, 'text/plain; charset=utf-8')
      if (reading.kind === 'none') {
        await upsertDoc(db, {
          doc_id: d.doc_id,
          source_id: KCS.reader,
          filed: d.filed,
          status: 'other',
          detail: `${reading.reason}: ${title}`,
          raw_key,
          source_url: d.source_url,
          fetched_at: at,
        })
        continue
      }
      const released = reading.observations[0]!.published_at ?? `${d.filed}T00:00:00Z`
      const stored = await storeObservations(db, reading.observations, {
        source_id,
        source_url: d.source_url,
        fetched_at: at,
        raw_key,
        basis: deps.now.getTime() - Date.parse(released) < LIVE_WINDOW_MS ? 'live' : 'backfill',
      })
      await upsertDoc(db, {
        doc_id: d.doc_id,
        source_id: KCS.reader,
        filed: d.filed,
        status: 'read',
        detail: source_id,
        raw_key,
        source_url: d.source_url,
        fetched_at: at,
      })
      if (parsed.kogl_type1) report.marked++
      else report.unmarked++
      report.added += stored.added
      report.revised += stored.revised
    } catch (error) {
      await failed()
      await fail(db, `${KCS.reader} ${ntt_sn}: ${String(error)}`)
    }
  }
  return report
}

/**
 * Each Korea month Comtrade lists, read when it is new or its lastReleased has
 * moved. A month's print_documents row holds the lastReleased it was read at
 * (detail), so a re-release is read again; a different figure becomes the
 * next vintage, the same figure is no row.
 */
export async function readComtrade(db: PipelineDb, deps: PrintDeps): Promise<ComtradeReport> {
  const report: ComtradeReport = { listed: 0, read: 0, added: 0, revised: 0, pending: 0 }
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const docs = tables.printDocuments
  const da = await deps.fetcher({
    source_id: COMTRADE.source_id,
    url: comtradeAvailabilityUrl(),
    ext: 'json',
  })
  if (!da.ok) {
    await fail(db, `${COMTRADE.source_id}: getDA ${da.detail}`)
    return report
  }
  let releases
  try {
    releases = parseComtradeAvailability(da.text)
  } catch (error) {
    await fail(db, `${COMTRADE.source_id}: ${String(error)}`)
    return report
  }
  report.listed = releases.length
  const held = new Map(
    (
      await db
        .select({
          doc_id: docs.doc_id,
          status: docs.status,
          detail: docs.detail,
          fetched_at: docs.fetched_at,
        })
        .from(docs)
        .where(eq(docs.source_id, COMTRADE.source_id))
    ).map((d) => [d.doc_id, d]),
  )
  const docId = (period: string) => `comtrade:${COMTRADE.reporter}:${period}`
  const due = releases.filter((r) => {
    const d = held.get(docId(r.period))
    if (!d) return true
    if (d.status === 'failed')
      return deps.now.getTime() - Date.parse(d.fetched_at) > FAILED_RETRY_MS
    return d.detail !== r.last_released
  })
  report.pending = Math.max(0, due.length - COMTRADE_PERIODS_PER_RUN)

  for (const [i, r] of due.slice(0, COMTRADE_PERIODS_PER_RUN).entries()) {
    if (i > 0) await sleep(COMTRADE_SPACING_MS)
    const url = comtradePreviewUrl(r.period)
    const at = new Date().toISOString()
    const doc = {
      doc_id: docId(r.period),
      source_id: COMTRADE.source_id,
      filed: r.last_released.slice(0, 10),
      source_url: url,
      fetched_at: at,
    }
    report.read++
    const res = await deps.fetcher({ source_id: COMTRADE.source_id, url, ext: 'json' })
    if (!res.ok) {
      await upsertDoc(db, { ...doc, status: 'failed', detail: res.detail, raw_key: null })
      if (res.status === 429) {
        await fail(db, `${COMTRADE.source_id}: HTTP 429`)
        break
      }
      continue
    }
    try {
      const o = parseComtradePreview(res.text, r)
      // Listed but not served yet: read again next run.
      if (!o) continue
      const raw_key = `prints/comtrade/${COMTRADE.reporter}-${COMTRADE.cmd}-${r.period}-${r.last_released.slice(0, 10)}.json`
      await deps.raw.put(raw_key, res.text, 'application/json')
      const stored = await storeObservations(db, [o], {
        source_id: COMTRADE.source_id,
        source_url: url,
        fetched_at: at,
        raw_key,
        basis:
          deps.now.getTime() - Date.parse(r.last_released) < LIVE_WINDOW_MS ? 'live' : 'backfill',
      })
      await upsertDoc(db, { ...doc, status: 'read', detail: r.last_released, raw_key })
      report.added += stored.added
      report.revised += stored.revised
    } catch (error) {
      await upsertDoc(db, { ...doc, status: 'failed', detail: String(error), raw_key: null })
      await fail(db, `${COMTRADE.source_id} ${r.period}: ${String(error)}`)
    }
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
  const kcs = await readKcs(db, deps).catch(async (error: unknown) => {
    await fail(db, `${KCS.reader}: ${String(error)}`)
    return {
      pages: 0,
      board: 'listing' as const,
      read: 0,
      marked: 0,
      unmarked: 0,
      added: 0,
      revised: 0,
      pending: -1,
    }
  })
  const comtrade = await readComtrade(db, deps).catch(async (error: unknown) => {
    await fail(db, `${COMTRADE.source_id}: ${String(error)}`)
    return { listed: 0, read: 0, added: 0, revised: 0, pending: -1 }
  })
  return { feeds, tsmc, kcs, comtrade }
}
