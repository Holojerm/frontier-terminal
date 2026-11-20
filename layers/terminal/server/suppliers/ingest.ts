// One run of the suppliers reader, after each filings-lane poll (six-hourly):
//
//   1. the hand-read rows are copied into supplier_passages once (store.ts);
//   2. each filer's submissions feed lists its documents of the forms it is
//      read for (filers.ts), filed after its newest hand-read row and within
//      the last year;
//   3. the newest of those not yet read are fetched, at most DOCS_PER_RUN a
//      run across filers, and stored in R2. A document read once is never
//      fetched again; a failed one is retried after a day;
//   4. a row whose quote a later document of the same form repeats now cites
//      that document (restampPassages);
//   5. a document whose text names a counterparty or a customer share waits
//      for the judge (review.ts). One that names none is settled now: the
//      rows of its form it no longer repeats have ended (settleDocument).
//
// Only the primary document is read: an exhibit to an 8-K or 6-K (a press
// release, interim statements) is not, and the table says so.
//
// Every request goes to SEC through the lane's paced fetcher. On a 429 the run
// stops fetching and spools one ops event; the next run starts over.

import { and, eq, gt, inArray, isNull } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { recordOpsEvent } from '#server/utils/ops'
import type { SourceFetcher } from '../pipeline/fetch'
import type { RawStore } from '../pipeline/refresh'
import type { PipelineDb } from '../pipeline/store'
import { documentText, supplierExcerpts } from './excerpts'
import { SUPPLIER_FILERS, type SupplierFiler } from './filers'
import {
  handReadThrough,
  restampPassages,
  seedHandPassages,
  settleDocument,
  type DocumentRef,
} from './store'

export const DOCS_PER_RUN = 6
const LOOKBACK_MS = 365 * 86_400_000
export const FAILED_RETRY_MS = 86_400_000

export interface SupplierDoc {
  accession_no: string
  form: string
  filed: string
  report_date: string | null
  url: string
}

/** The documents of `forms` in a submissions feed filed after `after`, newest first. */
export function supplierDocuments(
  body: string,
  filer: Pick<SupplierFiler, 'cik' | 'forms'>,
  after: string,
): SupplierDoc[] {
  const doc = JSON.parse(body) as {
    cik?: string
    filings?: {
      recent?: {
        form: string[]
        accessionNumber: string[]
        filingDate: string[]
        reportDate: string[]
        primaryDocument: string[]
      }
    }
  }
  const r = doc.filings?.recent
  if (!r) throw new Error('not an EDGAR submissions feed')
  if (Number(doc.cik) !== Number(filer.cik))
    throw new Error(`submissions feed is for CIK ${doc.cik}`)
  const out: SupplierDoc[] = []
  for (let i = 0; i < r.form.length; i++) {
    const form = r.form[i]!
    const filed = r.filingDate[i]!
    const primary = r.primaryDocument[i]!
    if (!filer.forms.includes(form) || filed <= after) continue
    if (!/^[\w.-]+\.html?$/i.test(primary)) continue
    const accession_no = r.accessionNumber[i]!
    out.push({
      accession_no,
      form,
      filed,
      report_date: r.reportDate[i] || null,
      url: `https://www.sec.gov/Archives/edgar/data/${Number(filer.cik)}/${accession_no.replace(/-/g, '')}/${primary}`,
    })
  }
  return out.sort((a, b) => (a.filed < b.filed ? 1 : a.filed > b.filed ? -1 : 0))
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/** "quarter ended September 28, 2026" for a 10-Q, "fiscal year ended …" for an annual report. */
export function periodOf(form: string, reportDate: string | null): string | null {
  if (!reportDate || !/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) return null
  const [y, m, d] = reportDate.split('-').map(Number)
  const date = `${MONTHS[m! - 1]} ${d}, ${y}`
  if (form === '10-Q') return `quarter ended ${date}`
  if (form === '10-K' || form === '20-F') return `fiscal year ended ${date}`
  return null
}

export const documentRef = (
  filer: Pick<SupplierFiler, 'ticker' | 'company'>,
  d: { accession_no: string; form: string; filed: string; report_date: string | null },
  source_url: string,
  fetched_at: string,
): DocumentRef => ({
  accession_no: d.accession_no,
  ticker: filer.ticker,
  form: d.form,
  filed: d.filed,
  source_url,
  fetched_at,
  source_title: `${filer.company} ${d.form}, filed ${d.filed}`,
  period: periodOf(d.form, d.report_date),
})

export interface SupplierDeps {
  raw: RawStore
  fetcher: SourceFetcher
  now: Date
}

export interface SupplierReadReport {
  seeded: number
  read: { ticker: string; accession_no: string; form: string; status: string; excerpts: number }[]
  restamped: number
  ended: number
  rate_limited: boolean
}

const submissionsUrl = (cik: string) => `https://data.sec.gov/submissions/CIK${cik}.json`

export async function runSupplierReads(
  db: PipelineDb,
  deps: SupplierDeps,
): Promise<SupplierReadReport> {
  const now = deps.now.toISOString()
  const report: SupplierReadReport = {
    seeded: await seedHandPassages(db),
    read: [],
    restamped: 0,
    ended: 0,
    rate_limited: false,
  }
  const through = await handReadThrough(db)
  const floor = new Date(deps.now.getTime() - LOOKBACK_MS).toISOString().slice(0, 10)

  const stored = new Map(
    (
      await db
        .select({
          accession_no: tables.supplierDocuments.accession_no,
          status: tables.supplierDocuments.status,
          fetched_at: tables.supplierDocuments.fetched_at,
        })
        .from(tables.supplierDocuments)
    ).map((d) => [d.accession_no, d]),
  )
  const due = (accession: string) => {
    const s = stored.get(accession)
    if (!s) return true
    return s.status === 'failed' && deps.now.getTime() - Date.parse(s.fetched_at) > FAILED_RETRY_MS
  }

  const queue: { filer: SupplierFiler; doc: SupplierDoc }[] = []
  for (const filer of SUPPLIER_FILERS) {
    const after = [through.get(filer.ticker) ?? '', floor].sort().at(-1)!
    const sub = await deps.fetcher({
      source_id: `supplier-${filer.ticker.toLowerCase()}-submissions`,
      url: submissionsUrl(filer.cik),
      ext: 'json',
    })
    if (!sub.ok) {
      if (sub.status === 429) {
        report.rate_limited = true
        break
      }
      continue
    }
    try {
      for (const doc of supplierDocuments(sub.text, filer, after)) {
        if (due(doc.accession_no)) queue.push({ filer, doc })
      }
    } catch (error) {
      await recordOpsEvent(db, {
        kind: 'supplier_read_failed',
        detail: `${filer.ticker} submissions: ${String(error)}`,
      })
    }
  }
  queue.sort((a, b) => (a.doc.filed < b.doc.filed ? 1 : a.doc.filed > b.doc.filed ? -1 : 0))

  for (const { filer, doc } of report.rate_limited ? [] : queue.slice(0, DOCS_PER_RUN)) {
    const fetched = await deps.fetcher({
      source_id: `supplier-${filer.ticker.toLowerCase()}-${doc.accession_no}`,
      url: doc.url,
      ext: 'html',
    })
    const base = {
      accession_no: doc.accession_no,
      ticker: filer.ticker,
      form: doc.form,
      filed: doc.filed,
      report_date: doc.report_date,
      source_url: doc.url,
      fetched_at: now,
    }
    if (!fetched.ok) {
      if (fetched.status === 429) {
        report.rate_limited = true
        break
      }
      await upsertDocument(db, {
        ...base,
        status: 'failed',
        detail: fetched.detail,
        raw_key: null,
        excerpts: 0,
      })
      report.read.push({
        ticker: filer.ticker,
        accession_no: doc.accession_no,
        form: doc.form,
        status: 'failed',
        excerpts: 0,
      })
      continue
    }
    const raw_key = `suppliers/${filer.ticker.toLowerCase()}/${doc.accession_no}.htm`
    await deps.raw.put(raw_key, fetched.text, 'text/html')
    const text = documentText(fetched.text)
    const excerpts = supplierExcerpts(text, filer.ticker).length
    await upsertDocument(db, { ...base, status: 'read', detail: null, raw_key, excerpts })
    const ref = documentRef(filer, doc, doc.url, now)
    report.restamped += await restampPassages(db, ref, text)
    if (excerpts === 0) report.ended += await settleDocument(db, ref, text, now)
    report.read.push({
      ticker: filer.ticker,
      accession_no: doc.accession_no,
      form: doc.form,
      status: 'read',
      excerpts,
    })
  }

  if (report.rate_limited) {
    await recordOpsEvent(db, {
      kind: 'supplier_read_failed',
      detail: 'SEC answered 429; the rest of this run’s supplier documents wait for the next run',
    })
  }
  return report
}

type DocumentInsert = typeof tables.supplierDocuments.$inferInsert

async function upsertDocument(db: PipelineDb, row: Omit<DocumentInsert, 'judged_at'>) {
  await db
    .insert(tables.supplierDocuments)
    .values({ ...row, judged_at: null })
    .onConflictDoUpdate({
      target: tables.supplierDocuments.accession_no,
      set: {
        status: row.status,
        detail: row.detail,
        raw_key: row.raw_key,
        excerpts: row.excerpts,
        fetched_at: row.fetched_at,
      },
    })
}

/** Documents the judge has yet to read, oldest filing first. */
export async function pendingDocuments(db: PipelineDb, accessions?: readonly string[]) {
  return db
    .select()
    .from(tables.supplierDocuments)
    .where(
      and(
        eq(tables.supplierDocuments.status, 'read'),
        gt(tables.supplierDocuments.excerpts, 0),
        isNull(tables.supplierDocuments.judged_at),
        accessions ? inArray(tables.supplierDocuments.accession_no, [...accessions]) : undefined,
      ),
    )
    .orderBy(tables.supplierDocuments.filed)
}
