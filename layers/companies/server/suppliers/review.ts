// The judge's reading of a supplier's new SEC document. GET /api/judge/pending
// offers each document the reader stored and found a counterparty in
// (ingest.ts) as a SUPPLIER REVIEW entry: excerpts of its text, and the rows
// the table already holds for that company. The judge sends back, per
// document, the passages that tie the company to a lab, a cloud or an unnamed
// customer, or none.
//
// The model only finds the passage and says what it states. The Worker
// decides, against the document as R2 holds it:
//   1. the document was offered and is not settled yet;
//   2. the quote is in the document verbatim (see contains);
//   3. the counterparty is named in the quote, or by a term the alias quote
//      defines; a concentration row's label ("Customer A") is in the quote;
//   4. every figure is written in the quote, in the unit it claims;
//   5. ticker, company, layer, form, filing date, period, the counterparty's
//      ticker and lab, and provenance are set here, never by the model.
// A passage that fails is dropped, with an ops event. Once a document is
// answered it is settled: rows of its form it no longer repeats have ended.

import { z } from 'zod'

import {
  SUPPLIER_RELATIONS,
  SUPPLIER_UNITS,
  type CuratedSupplierRow,
} from '../../shared/utils/suppliers'
import type { RawReader } from '#layers/core/server/pipeline/raw'
import { contains, documentText } from '#layers/core/server/pipeline/document-text'
import { chunk, runStatements, type PipelineDb } from '#layers/core/server/pipeline/store'
import * as tables from '#server/db/schema'
import { comparable } from '#layers/core/server/utils/quote-match'
import { figureWritten, supplierExcerpts } from './excerpts'
import { SUPPLIER_FILERS, counterpartyNamed } from './filers'
import { documentRef, pendingDocuments } from './ingest'
import { PASSAGE_ROWS_PER_INSERT, currentPassages, insertOf, settleDocument } from './store'
import { judgeReview } from '#layers/core/server/pipeline/judge/review'

/** Documents offered per judge run, oldest filing first. */
export const SUPPLIER_REVIEW_LIMIT = 6

const JudgeSupplierPassage = z.strictObject({
  relation: z.enum(SUPPLIER_RELATIONS),
  counterparty: z.string().min(1).max(80),
  figures: z
    .array(
      z.strictObject({
        value: z.number().positive(),
        unit: z.enum(SUPPLIER_UNITS),
        meaning: z.string().min(1).max(200),
      }),
    )
    .max(3),
  quote: z.string().min(20).max(400),
  alias: z
    .strictObject({ term: z.string().min(1).max(60), quote: z.string().min(20).max(400) })
    .nullable(),
})

export const JudgeSupplierReading = z.strictObject({
  document_id: z.string().min(1).max(40),
  passages: JudgeSupplierPassage.array().max(30),
})
export type JudgeSupplierReading = z.infer<typeof JudgeSupplierReading>
type Passage = z.infer<typeof JudgeSupplierPassage>

export interface SupplierReview {
  document_id: string
  ticker: string
  company: string
  form: string
  filed: string
  /** The rows the table holds for this company now: send a passage only if it is not one of these. */
  known: {
    relation: string
    counterparty: string
    figures: unknown
    quote: string
    form: string
    filed: string
  }[]
  /** Runs of the document's text, each verbatim. */
  excerpts: string[]
}

const FILER = new Map(SUPPLIER_FILERS.map((f) => [f.ticker, f]))

/** The SUPPLIER REVIEW block: the oldest unsettled documents, with their text. */
export async function supplierReview(
  db: PipelineDb,
  readRaw: RawReader,
  limit = SUPPLIER_REVIEW_LIMIT,
): Promise<SupplierReview[]> {
  const out: SupplierReview[] = []
  for (const doc of await pendingDocuments(db)) {
    if (out.length >= limit) break
    const filer = FILER.get(doc.ticker)
    const html = doc.raw_key ? await readRaw(doc.raw_key) : null
    if (!filer || html === null) continue
    const known = (await currentPassages(db, doc.ticker)).map((r) => ({
      relation: r.relation,
      counterparty: r.counterparty,
      figures: JSON.parse(r.figures) as unknown,
      quote: r.quote,
      form: r.form,
      filed: r.filed,
    }))
    out.push({
      document_id: doc.accession_no,
      ticker: doc.ticker,
      company: filer.company,
      form: doc.form,
      filed: doc.filed,
      known,
      excerpts: supplierExcerpts(documentText(html), doc.ticker),
    })
  }
  return out
}

/** Why a passage doesn't hold against the document, or null when it does. */
export function checkPassage(p: Passage, text: string): { reason: string; detail: string } | null {
  const short = p.quote.slice(0, 120)
  if (!contains(text, p.quote)) return { reason: 'quote-not-in-document', detail: short }
  if (p.alias) {
    if (!contains(text, p.alias.quote))
      return { reason: 'alias-not-in-document', detail: p.alias.quote.slice(0, 120) }
    if (!contains(p.quote, p.alias.term) || !contains(p.alias.quote, p.alias.term))
      return { reason: 'alias-term-not-quoted', detail: p.alias.term }
    if (!contains(p.alias.quote, p.counterparty))
      return { reason: 'alias-names-no-counterparty', detail: p.counterparty }
  } else if (!contains(p.quote, p.counterparty)) {
    return { reason: 'counterparty-not-in-quote', detail: p.counterparty }
  }
  if (p.relation === 'concentration' && counterpartyNamed(p.counterparty)) {
    return { reason: 'concentration-names-a-company', detail: p.counterparty }
  }
  for (const f of p.figures) {
    if (!figureWritten(p.quote, f))
      return { reason: 'figure-not-in-quote', detail: `${f.value} ${f.unit}` }
  }
  return null
}

export interface SupplierReport {
  accepted: number
  ended: number
  settled: number
  rejected: { reason: string; detail: string; document_id: string }[]
}

/** Gate and store the supplier readings of one judge run, then settle each document answered. */
export async function applySupplierReadings(
  db: PipelineDb,
  readRaw: RawReader,
  readings: readonly JudgeSupplierReading[],
  now: Date,
): Promise<SupplierReport> {
  const report: SupplierReport = { accepted: 0, ended: 0, settled: 0, rejected: [] }
  if (!readings.length) return report
  const at = now.toISOString()
  const pending = new Map(
    (
      await pendingDocuments(
        db,
        readings.map((r) => r.document_id),
      )
    ).map((d) => [d.accession_no, d]),
  )
  for (const reading of readings) {
    const { document_id } = reading
    const doc = pending.get(document_id)
    const filer = doc ? FILER.get(doc.ticker) : undefined
    if (!doc || !filer) {
      report.rejected.push({ reason: 'not-offered', detail: document_id, document_id })
      continue
    }
    const html = doc.raw_key ? await readRaw(doc.raw_key) : null
    if (html === null) {
      report.rejected.push({
        reason: 'document-not-stored',
        detail: String(doc.raw_key),
        document_id,
      })
      continue
    }
    pending.delete(document_id)
    const text = documentText(html)
    const ref = documentRef(filer, doc, doc.source_url, doc.fetched_at)
    const held = new Set(
      (await currentPassages(db, doc.ticker)).map((r) => comparable(r.quote).toLowerCase()),
    )
    const rows: ReturnType<typeof insertOf>[] = []
    for (const p of reading.passages) {
      const failed = checkPassage(p, text)
      if (failed) {
        report.rejected.push({ ...failed, document_id })
        continue
      }
      const key = comparable(p.quote).toLowerCase()
      if (held.has(key)) continue
      held.add(key)
      const named = p.relation === 'concentration' ? null : counterpartyNamed(p.counterparty)
      const row: CuratedSupplierRow = {
        ticker: filer.ticker,
        company: filer.company,
        layer: filer.layer,
        relation: p.relation,
        counterparty: named?.name ?? p.counterparty,
        counterparty_ticker: named?.ticker ?? null,
        counterparty_lab: named?.lab ?? null,
        figures: p.figures,
        form: doc.form,
        filed: doc.filed,
        period: ref.period,
        source_url: doc.source_url,
        source_title: ref.source_title,
        quote: p.quote,
        alias: p.alias,
        fetched_at: doc.fetched_at,
      }
      rows.push(insertOf(row, 'judge', at))
    }
    await runStatements(
      db,
      chunk(rows, PASSAGE_ROWS_PER_INSERT).map((part) =>
        db.insert(tables.supplierPassages).values(part).onConflictDoNothing(),
      ),
    )
    report.accepted += rows.length
    report.ended += await settleDocument(db, ref, text, at)
    report.settled++
  }
  return report
}

/** The supplier review (server/registries/judge.ts): passages of a supplier's new SEC document. */
export const SUPPLIER_REVIEW = judgeReview({
  key: 'suppliers',
  reading: JudgeSupplierReading,
  max: 20,
  empty: { accepted: 0, ended: 0, settled: 0, rejected: [] } as SupplierReport,
  apply: ({ db, readRaw, now }, readings) => applySupplierReadings(db, readRaw, readings, now),
  rejected: { noun: 'supplier passage(s)', subject: 'document_id' },
  offer: { key: 'supplier_review', read: ({ db, readRaw }) => supplierReview(db, readRaw) },
})
