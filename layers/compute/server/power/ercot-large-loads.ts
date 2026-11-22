// One run of the ERCOT large-load reader (daily, with the EIA-930 read): at most
// REPORTS_PER_RUN reports, oldest first so vintages arrive in order, each read
// once with its bytes in R2; a failed one is retried after a day.

import { desc, inArray } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import {
  activeRelay,
  isRelayed,
  relayedBytes,
  type RelayStore,
} from '#layers/core/server/pipeline/relay'
import { ercotFacts, ercotListings, ercotReportLinks, type ErcotReportLink } from './ercot-reports'
import { pdfPages } from '#layers/core/server/pipeline/pdf-text'

const REPORTS_PER_RUN = 12
const REPORT_MAX_BYTES = 20 * 1024 * 1024
const RETRY_MS = 86_400_000

interface ErcotDeps {
  /** The listing pages are HTML: the pipeline's fetcher. */
  fetcher: SourceFetcher
  /** R2, binary. */
  put(key: string, body: Uint8Array, contentType: string): Promise<void>
  fetch?: typeof globalThis.fetch
  /** ERCOT refuses Workers' egress; defaults to the registered relay (core relay.ts). */
  relay?: RelayStore | null
  userAgent: string
  now: Date
}

interface ErcotRunReport {
  listed: number
  read: {
    url: string
    status: 'read' | 'none' | 'failed' | 'pending'
    facts: number
    detail: string | null
  }[]
  listing_failures: string[]
}

async function fetchPdf(
  url: string,
  deps: ErcotDeps,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; detail: string; pending?: true }> {
  const relay = isRelayed(url) ? (deps.relay ?? activeRelay()) : null
  if (relay) {
    const got = await relayedBytes(relay, url)
    if (got.ok) return { ok: true, bytes: got.body }
    return got.pending
      ? { ok: false, detail: got.detail, pending: true }
      : { ok: false, detail: got.detail }
  }
  const res = await (deps.fetch ?? globalThis.fetch)(url, {
    headers: { 'User-Agent': deps.userAgent, Accept: 'application/pdf' },
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` }
  const declared = Number(res.headers.get('content-length'))
  if (declared > REPORT_MAX_BYTES)
    return { ok: false, detail: `body exceeds ${REPORT_MAX_BYTES} bytes` }
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.byteLength > REPORT_MAX_BYTES)
    return { ok: false, detail: `body exceeds ${REPORT_MAX_BYTES} bytes` }
  return { ok: true, bytes }
}

async function readReport(db: PipelineDb, link: ErcotReportLink, deps: ErcotDeps) {
  const read_at = deps.now.toISOString()
  const settle = async (
    status: 'read' | 'none' | 'failed',
    facts: number,
    detail: string | null,
    raw_key: string | null,
  ) => {
    const row = { status, facts, detail, raw_key, read_at }
    await db
      .insert(tables.ercotLargeLoadReports)
      .values({
        url: link.url,
        series: link.series,
        title: link.title,
        posted: link.posted,
        ...row,
      })
      .onConflictDoUpdate({ target: tables.ercotLargeLoadReports.url, set: row })
    return { url: link.url, status, facts, detail }
  }
  const got = await fetchPdf(link.url, deps).catch((e: unknown) => ({
    ok: false as const,
    detail: `fetch threw: ${String(e)}`,
  }))
  // Left unsettled, so the next run asks again once the relay has it.
  if (!got.ok && 'pending' in got)
    return { url: link.url, status: 'pending' as const, facts: 0, detail: got.detail }
  if (!got.ok) return settle('failed', 0, got.detail, null)
  let facts
  try {
    facts = ercotFacts(await pdfPages(got.bytes), link)
  } catch (error) {
    return settle('failed', 0, `read: ${String(error)}`.slice(0, 300), null)
  }
  const raw_key = `grid-load/ercot/${contentHashOfText(new TextDecoder('latin1').decode(got.bytes))}.pdf`
  await deps.put(raw_key, got.bytes, 'application/pdf')
  if (facts.length > 0) {
    await db
      .insert(tables.ercotLargeLoadFacts)
      .values(
        facts.map((f) => ({
          id: contentHash({ report: link.url, metric: f.metric, period: f.period }),
          report_url: link.url,
          ...f,
          posted: link.posted,
          raw_key,
          source_url: link.url,
          fetched_at: read_at,
        })),
      )
      .onConflictDoNothing()
  }
  return settle(facts.length > 0 ? 'read' : 'none', facts.length, null, raw_key)
}

export async function runErcotLargeLoads(db: PipelineDb, deps: ErcotDeps): Promise<ErcotRunReport> {
  const links = new Map<string, ErcotReportLink>()
  const listing_failures: string[] = []
  // A listing waiting on the relay's first copy was not read (2026-11-22's first
  // relayed run alerted "no report linked" on three such pages).
  let listings_waiting = 0
  for (const listing of ercotListings(deps.now)) {
    const page = await deps.fetcher({
      source_id: 'ercot-large-loads',
      url: listing.url,
      ext: 'html',
    })
    if (!page.ok) {
      if ('skipped' in page) listings_waiting++
      else listing_failures.push(`${listing.url}: ${page.detail}`)
      continue
    }
    for (const l of ercotReportLinks(page.text, listing.series)) links.set(l.url, l)
  }
  const retryBefore = new Date(deps.now.getTime() - RETRY_MS).toISOString()
  // Read or read with no figure: settled. Failed: tried again a day later.
  const stored = await db
    .select({
      url: tables.ercotLargeLoadReports.url,
      status: tables.ercotLargeLoadReports.status,
      read_at: tables.ercotLargeLoadReports.read_at,
    })
    .from(tables.ercotLargeLoadReports)
  const skip = new Set(
    stored.filter((r) => r.status !== 'failed' || r.read_at >= retryBefore).map((r) => r.url),
  )
  const due = [...links.values()].filter((l) => !skip.has(l.url)).slice(0, REPORTS_PER_RUN)
  const read: ErcotRunReport['read'] = []
  for (const link of due) read.push(await readReport(db, link, deps))
  const failed = read.filter((r) => r.status === 'failed')
  if (failed.length > 0 || (links.size === 0 && listing_failures.length > 0)) {
    await recordOpsEvent(db, {
      kind: 'grid_load_read_failed',
      detail:
        `ERCOT large loads: ${[...failed.map((f) => `${f.url}: ${f.detail}`), ...listing_failures].join('; ')}`.slice(
          0,
          500,
        ),
    })
  }
  // Every listing read and none linking a report means ERCOT's pages changed shape.
  if (links.size === 0 && listing_failures.length === 0 && listings_waiting === 0) {
    await recordOpsEvent(db, {
      kind: 'grid_load_read_failed',
      detail: 'ERCOT large loads: no report linked from the Board or presentations pages',
    })
  }
  return { listed: links.size, read, listing_failures }
}

/** Every stored figure, newest report first. */
export async function ercotFactsStored(db: PipelineDb) {
  return db
    .select()
    .from(tables.ercotLargeLoadFacts)
    .orderBy(desc(tables.ercotLargeLoadFacts.posted), tables.ercotLargeLoadFacts.period)
}

export async function ercotReportCount(db: PipelineDb): Promise<number> {
  const rows = await db
    .select({ url: tables.ercotLargeLoadReports.url })
    .from(tables.ercotLargeLoadReports)
    .where(inArray(tables.ercotLargeLoadReports.status, ['read', 'none']))
  return rows.length
}
