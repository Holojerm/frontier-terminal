// One run of the power-sites reader, after each filings-lane poll. Hand-read rows
// are seeded once (store.ts); a quarter of the sites are searched each run
// (sites.ts, EDGAR full-text search); the newest unread hits are fetched
// (DOCS_PER_RUN) and stored in R2; repeated quotes are restamped (restampTies); a
// document speaking of power near the site waits for the judge (review.ts), others
// are settled now. On a SEC 429 the run stops and spools one ops event.

import { and, eq, gt, isNull, max } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { recordOpsEvent } from '#server/utils/ops'
import type { SourceFetcher } from '#layers/core/server/utils/pipeline-fetch'
import type { RawStore } from '#layers/core/server/utils/pipeline-raw'
import { documentText } from '#layers/core/server/pipeline/document-text'
import type { PipelineDb } from '#layers/core/server/utils/pipeline-store'
import { powerExcerpts } from './excerpts'
import { epochLabSites, searchFor, searchQuery, type LabSite, type SiteSearch } from './sites'
import { restampTies, seedHandTies, settleDocument, type PowerDocumentRef } from './store'

export const DOCS_PER_RUN = 4
/** Runs a day of the filings lane: each site is searched in one of them. */
export const SEARCH_SLOTS = 4
/** How far back a site no one has read is searched. */
const LOOKBACK_MS = 180 * 86_400_000
/** A site already read is searched from a month before the newest filing stored for it. */
const OVERLAP_MS = 30 * 86_400_000
export const FAILED_RETRY_MS = 86_400_000
/** The day the hand read covered filings through: a site it read is searched from here. */
export const HAND_READ_THROUGH = '2026-11-19'

/** The forms searched, and read when the hit is the main document or a press-release exhibit. */
export const POWER_FORMS: readonly string[] = ['10-K', '10-Q', '8-K', '20-F', '6-K', 'S-1', 'S-1/A']

export const KIND_READ_FAILED = 'power_site_read_failed'

export interface PowerDoc {
  document_id: string
  accession_no: string
  cik: string
  filer: string
  form: string
  file_type: string
  filed: string
  url: string
}

interface SearchHit {
  _id?: string
  _source?: {
    ciks?: string[]
    display_names?: string[]
    form?: string
    file_type?: string
    file_date?: string
  }
}

/** The documents in an EDGAR full-text search answer this reader reads, newest first. */
export function searchHits(body: string): PowerDoc[] {
  const doc = JSON.parse(body) as { hits?: { hits?: SearchHit[] } }
  if (!Array.isArray(doc.hits?.hits)) throw new Error('not an EDGAR full-text search answer')
  const out = new Map<string, PowerDoc>()
  for (const h of doc.hits.hits) {
    const s = h._source
    const id = h._id ?? ''
    const m = /^(\d{10}-\d{2}-\d{6}):([\w.-]+\.html?)$/i.exec(id)
    const cik = s?.ciks?.[0]
    if (!m || !s || !cik || !/^\d+$/.test(cik)) continue
    const form = s.form ?? ''
    const file_type = s.file_type ?? ''
    if (!POWER_FORMS.includes(form)) continue
    if (file_type !== form && !/^EX-99(\.\d+)?$/.test(file_type)) continue
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.file_date ?? '')) continue
    const [, accession_no, file] = m as unknown as [string, string, string]
    out.set(id, {
      document_id: id,
      accession_no,
      cik: String(Number(cik)),
      filer: s.display_names?.[0]?.trim() || `CIK ${Number(cik)}`,
      form,
      file_type,
      filed: s.file_date!,
      url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession_no.replace(/-/g, '')}/${file}`,
    })
  }
  return [...out.values()].sort((a, b) => (a.filed < b.filed ? 1 : a.filed > b.filed ? -1 : 0))
}

/** "TERAWULF INC.  (WULF)  (CIK 0001083301)" → name "TERAWULF INC.", ticker "WULF". */
export function filerOf(display: string): { name: string; ticker: string | null } {
  const name = display.replace(/\s*\(CIK \d+\)\s*$/, '')
  const t = /\s*\(([A-Z][A-Z.]{0,5})(?:,[^)]*)?\)\s*$/.exec(name)
  return {
    name: (t ? name.slice(0, t.index) : name).replace(/\s+/g, ' ').trim(),
    ticker: t ? t[1]! : null,
  }
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export function searchUrl(s: SiteSearch, startdt: string, enddt: string): string {
  const q = encodeURIComponent(searchQuery(s))
  return `https://efts.sec.gov/LATEST/search-index?q=${q}&forms=${POWER_FORMS.join(',')}&dateRange=custom&startdt=${startdt}&enddt=${enddt}`
}

export const documentRef = (
  site: string,
  d: Pick<
    PowerDoc,
    'document_id' | 'accession_no' | 'cik' | 'filer' | 'form' | 'file_type' | 'filed'
  >,
  source_url: string,
  fetched_at: string,
): PowerDocumentRef => {
  const { name } = filerOf(d.filer)
  const main = d.file_type === d.form
  return {
    document_id: d.document_id,
    site,
    accession_no: d.accession_no,
    cik: d.cik,
    form: main ? d.form : null,
    filed: d.filed,
    source_url,
    fetched_at,
    source_title: main
      ? `${name} Form ${d.form}, filed ${d.filed}`
      : `${name} ${d.file_type} to Form ${d.form}, filed ${d.filed}`,
    publisher: `${name} (SEC filing)`,
  }
}

export interface PowerDeps {
  raw: RawStore
  fetcher: SourceFetcher
  now: Date
  /** Runs a day each site is spread over; 1 searches every site this run. */
  slots?: number
}

export interface PowerReadReport {
  seeded: number
  searched: string[]
  /** Sites whose search failed this run, with why. */
  unsearched: string[]
  read: { site: string; document_id: string; form: string; status: string; excerpts: number }[]
  restamped: number
  ended: number
  rate_limited: boolean
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/** The sites this run searches: every SEARCH_SLOTS-th by name, offset by the run's six-hour slot. */
export function sitesDue(sites: readonly LabSite[], now: Date, slots = SEARCH_SLOTS): LabSite[] {
  const slot = Math.floor(now.getUTCHours() / (24 / slots)) % slots
  return [...sites]
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((_, i) => i % slots === slot)
}

export async function runPowerSiteReads(db: PipelineDb, deps: PowerDeps): Promise<PowerReadReport> {
  const now = deps.now.toISOString()
  const report: PowerReadReport = {
    seeded: await seedHandTies(db),
    searched: [],
    unsearched: [],
    read: [],
    restamped: 0,
    ended: 0,
    rate_limited: false,
  }

  const handSites = new Set(
    (
      await db
        .selectDistinct({ site: tables.powerSiteTies.site })
        .from(tables.powerSiteTies)
        .where(eq(tables.powerSiteTies.basis, 'hand'))
    ).map((r) => r.site),
  )
  const newestStored = new Map(
    (
      await db
        .select({
          site: tables.powerSiteDocuments.site,
          filed: max(tables.powerSiteDocuments.filed),
        })
        .from(tables.powerSiteDocuments)
        .groupBy(tables.powerSiteDocuments.site)
    ).map((r) => [r.site, r.filed ?? '']),
  )
  const stored = new Map(
    (
      await db
        .select({
          document_id: tables.powerSiteDocuments.document_id,
          site: tables.powerSiteDocuments.site,
          status: tables.powerSiteDocuments.status,
          fetched_at: tables.powerSiteDocuments.fetched_at,
        })
        .from(tables.powerSiteDocuments)
    ).map((d) => [`${d.document_id}|${d.site}`, d]),
  )
  const due = (document_id: string, site: string) => {
    const s = stored.get(`${document_id}|${site}`)
    if (!s) return true
    return s.status === 'failed' && deps.now.getTime() - Date.parse(s.fetched_at) > FAILED_RETRY_MS
  }

  const today = day(deps.now.getTime())
  const queue: { site: LabSite; search: SiteSearch; doc: PowerDoc }[] = []
  for (const site of sitesDue(await epochLabSites(db), deps.now, deps.slots)) {
    const search = searchFor(site)
    if (!search) continue
    const floor = handSites.has(site.name)
      ? HAND_READ_THROUGH
      : day(deps.now.getTime() - LOOKBACK_MS)
    const newest = newestStored.get(site.name)
    const since = newest ? day(Date.parse(`${newest}T00:00:00Z`) - OVERLAP_MS) : ''
    const startdt = [floor, since].sort().at(-1)!
    const res = await deps.fetcher({
      source_id: `power-site-search-${slug(site.name)}`,
      url: searchUrl(search, startdt, today),
      ext: 'json',
    })
    if (!res.ok) {
      if (res.status === 429) {
        report.rate_limited = true
        break
      }
      // Reported, not spooled: the next day's run asks again, as the suppliers reader does.
      report.unsearched.push(`${site.name}: ${res.detail}`)
      continue
    }
    report.searched.push(site.name)
    try {
      for (const doc of searchHits(res.text)) {
        if (due(doc.document_id, site.name)) queue.push({ site, search, doc })
      }
    } catch (error) {
      await recordOpsEvent(db, {
        kind: KIND_READ_FAILED,
        detail: `${site.name} search: ${String(error)}`,
      })
    }
  }
  queue.sort((a, b) => (a.doc.filed < b.doc.filed ? 1 : a.doc.filed > b.doc.filed ? -1 : 0))

  // A document found for two sites (one campus Epoch lists twice) is fetched once.
  const bodies = new Map<string, string>()
  const fetches = new Set<string>()
  for (const { site, search, doc } of report.rate_limited ? [] : queue) {
    if (!bodies.has(doc.document_id)) {
      if (fetches.size >= DOCS_PER_RUN) continue
      fetches.add(doc.document_id)
      const fetched = await deps.fetcher({
        source_id: `power-site-${doc.accession_no}`,
        url: doc.url,
        ext: 'html',
      })
      if (!fetched.ok) {
        if (fetched.status === 429) {
          report.rate_limited = true
          break
        }
        await upsertDocument(
          db,
          docRow(site.name, search, doc, now, 'failed', fetched.detail, null, 0),
        )
        report.read.push({
          site: site.name,
          document_id: doc.document_id,
          form: doc.form,
          status: 'failed',
          excerpts: 0,
        })
        continue
      }
      await deps.raw.put(rawKey(doc), fetched.text, 'text/html')
      bodies.set(doc.document_id, fetched.text)
    }
    const text = documentText(bodies.get(doc.document_id)!)
    const excerpts = powerExcerpts(text, search.terms).length
    await upsertDocument(
      db,
      docRow(site.name, search, doc, now, 'read', null, rawKey(doc), excerpts),
    )
    const ref = documentRef(site.name, doc, doc.url, now)
    report.restamped += await restampTies(db, ref, text)
    if (excerpts === 0) report.ended += await settleDocument(db, ref, text, now)
    report.read.push({
      site: site.name,
      document_id: doc.document_id,
      form: doc.form,
      status: 'read',
      excerpts,
    })
  }

  if (report.rate_limited) {
    await recordOpsEvent(db, {
      kind: KIND_READ_FAILED,
      detail: 'SEC answered 429; the rest of this run’s power-site searches wait for the next run',
    })
  }
  return report
}

export const rawKey = (d: Pick<PowerDoc, 'document_id'>) =>
  `power-sites/${d.document_id.replace(':', '/')}`

type DocumentInsert = typeof tables.powerSiteDocuments.$inferInsert

const docRow = (
  site: string,
  search: SiteSearch,
  d: PowerDoc,
  fetched_at: string,
  status: 'read' | 'failed',
  detail: string | null,
  raw_key: string | null,
  excerpts: number,
): Omit<DocumentInsert, 'judged_at'> => ({
  document_id: d.document_id,
  site,
  accession_no: d.accession_no,
  cik: d.cik,
  filer: d.filer,
  form: d.form,
  file_type: d.file_type,
  filed: d.filed,
  terms: JSON.stringify(search.terms),
  status,
  detail,
  raw_key,
  excerpts,
  source_url: d.url,
  fetched_at,
})

async function upsertDocument(db: PipelineDb, row: Omit<DocumentInsert, 'judged_at'>) {
  await db
    .insert(tables.powerSiteDocuments)
    .values({ ...row, judged_at: null })
    .onConflictDoUpdate({
      target: [tables.powerSiteDocuments.document_id, tables.powerSiteDocuments.site],
      set: {
        status: row.status,
        detail: row.detail,
        raw_key: row.raw_key,
        excerpts: row.excerpts,
        terms: row.terms,
        fetched_at: row.fetched_at,
      },
    })
}

/** Documents the judge has yet to read, oldest filing first. */
export async function pendingDocuments(db: PipelineDb) {
  return db
    .select()
    .from(tables.powerSiteDocuments)
    .where(
      and(
        eq(tables.powerSiteDocuments.status, 'read'),
        gt(tables.powerSiteDocuments.excerpts, 0),
        isNull(tables.powerSiteDocuments.judged_at),
      ),
    )
    .orderBy(tables.powerSiteDocuments.filed)
}
