// The stored suppliers table: the hand-read rows it starts from, the rows a
// reader sees, and what a newly read document does to the rows before it.

import { and, count, desc, eq, isNull, max } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import {
  curatedSuppliers,
  type CuratedSupplierRow,
  type SupplierBasis,
  type SupplierRow,
} from '../../shared/utils/suppliers'
import type { LabId } from '../../../core/shared/types/common'
import curated from '../curated/suppliers.json'
import { accessionOf, contentHash } from '#layers/core/server/utils/contracts/keys'
import {
  chunk,
  D1_MAX_BOUND_PARAMS,
  runStatements,
  type PipelineDb,
} from '#layers/core/server/utils/pipeline-store'
import { contains } from '#layers/core/server/pipeline/document-text'
import { PERIODIC_FORMS } from './filers'

const HAND = curatedSuppliers.parse(curated).rows

type Stored = typeof tables.supplierPassages.$inferSelect
type Insert = typeof tables.supplierPassages.$inferInsert

/** The row id: the same five fields the export has always keyed passages on. */
const passageId = (
  r: Pick<CuratedSupplierRow, 'ticker' | 'relation' | 'counterparty' | 'source_url' | 'quote'>,
) =>
  contentHash({
    ticker: r.ticker,
    relation: r.relation,
    counterparty: r.counterparty,
    source_url: r.source_url,
    quote: r.quote,
  })

export function insertOf(
  r: CuratedSupplierRow,
  basis: SupplierBasis,
  first_seen_at: string,
): Insert {
  return {
    id: passageId(r),
    ticker: r.ticker,
    company_name: r.company,
    layer: r.layer,
    relation: r.relation,
    counterparty: r.counterparty,
    counterparty_ticker: r.counterparty_ticker,
    counterparty_lab: r.counterparty_lab,
    figures: JSON.stringify(r.figures),
    form: r.form,
    filed: r.filed,
    period: r.period,
    source_title: r.source_title,
    quote: r.quote,
    alias_term: r.alias?.term ?? null,
    alias_quote: r.alias?.quote ?? null,
    basis,
    accession_no: accessionOf(r.source_url),
    first_seen_at,
    ended_at: null,
    ended_by: null,
    source_url: r.source_url,
    fetched_at: r.fetched_at,
  }
}

export function rowOf(s: Stored): SupplierRow {
  return {
    ticker: s.ticker,
    company: s.company_name,
    layer: s.layer as SupplierRow['layer'],
    relation: s.relation as SupplierRow['relation'],
    counterparty: s.counterparty,
    counterparty_ticker: s.counterparty_ticker,
    counterparty_lab: s.counterparty_lab as LabId | null,
    figures: JSON.parse(s.figures) as SupplierRow['figures'],
    form: s.form,
    filed: s.filed,
    period: s.period,
    source_url: s.source_url,
    source_title: s.source_title,
    quote: s.quote,
    alias: s.alias_term && s.alias_quote ? { term: s.alias_term, quote: s.alias_quote } : null,
    fetched_at: s.fetched_at,
    basis: s.basis as SupplierBasis,
  }
}

/** Rows per insert under D1's bound-parameter limit: 23 columns each. */
export const PASSAGE_ROWS_PER_INSERT = Math.floor(D1_MAX_BOUND_PARAMS / 23)

/** Copy the hand-read rows in, once: a row already stored, ended or not, is left as it is. */
export async function seedHandPassages(db: PipelineDb): Promise<number> {
  const [stored] = await db
    .select({ n: count() })
    .from(tables.supplierPassages)
    .where(eq(tables.supplierPassages.basis, 'hand'))
  if ((stored?.n ?? 0) >= HAND.length) return 0
  const rows = HAND.map((r) => insertOf(r, 'hand', r.fetched_at))
  await runStatements(
    db,
    chunk(rows, PASSAGE_ROWS_PER_INSERT).map((part) =>
      db.insert(tables.supplierPassages).values(part).onConflictDoNothing(),
    ),
  )
  return rows.length - (stored?.n ?? 0)
}

/** The rows no later document has ended, newest document first. */
export async function currentPassages(db: PipelineDb, ticker?: string): Promise<Stored[]> {
  return db
    .select()
    .from(tables.supplierPassages)
    .where(
      and(
        isNull(tables.supplierPassages.ended_at),
        ticker ? eq(tables.supplierPassages.ticker, ticker) : undefined,
      ),
    )
    .orderBy(desc(tables.supplierPassages.filed), tables.supplierPassages.first_seen_at)
}

/** Moves whenever a row is added, restamped or ended. */
export async function suppliersStamp(db: PipelineDb): Promise<string> {
  const [row] = await db
    .select({
      n: count(),
      fetched: max(tables.supplierPassages.fetched_at),
      ended: max(tables.supplierPassages.ended_at),
    })
    .from(tables.supplierPassages)
  return `${row?.n ?? 0}:${row?.fetched ?? ''}:${row?.ended ?? ''}`
}

export interface DocumentRef {
  accession_no: string
  ticker: string
  form: string
  filed: string
  source_url: string
  fetched_at: string
  source_title: string
  period: string | null
}

/**
 * A row whose quote is in a later document of the same form now cites that
 * document. Run when a document is read, before the judge sees it, so a
 * passage a company repeats word for word stays current without a reading.
 */
export async function restampPassages(
  db: PipelineDb,
  doc: DocumentRef,
  text: string,
): Promise<number> {
  const rows = (await currentPassages(db, doc.ticker)).filter(
    (r) => r.form === doc.form && r.filed < doc.filed && contains(text, r.quote),
  )
  await runStatements(
    db,
    rows.map((r) =>
      db
        .update(tables.supplierPassages)
        .set({
          source_url: doc.source_url,
          fetched_at: doc.fetched_at,
          filed: doc.filed,
          accession_no: doc.accession_no,
          source_title: doc.source_title,
          period: doc.period,
        })
        .where(eq(tables.supplierPassages.id, r.id)),
    ),
  )
  return rows.length
}

/**
 * Settle a document once nothing more will be read from it: rows of the same
 * periodic form from an earlier document whose quote it no longer has have
 * ended. A filing restates its periodic disclosures, so a passage it drops is
 * no longer the company's word; an 8-K or 6-K states one event and never ends.
 */
export async function settleDocument(
  db: PipelineDb,
  doc: DocumentRef,
  text: string,
  now: string,
): Promise<number> {
  const ended = PERIODIC_FORMS.includes(doc.form)
    ? (await currentPassages(db, doc.ticker)).filter(
        (r) => r.form === doc.form && r.filed < doc.filed && !contains(text, r.quote),
      )
    : []
  await runStatements(db, [
    ...ended.map((r) =>
      db
        .update(tables.supplierPassages)
        .set({ ended_at: now, ended_by: doc.accession_no })
        .where(eq(tables.supplierPassages.id, r.id)),
    ),
    db
      .update(tables.supplierDocuments)
      .set({ judged_at: now })
      .where(eq(tables.supplierDocuments.accession_no, doc.accession_no)),
  ])
  return ended.length
}

/** The filing date the reader starts after for one company: its newest hand-read row. */
export async function handReadThrough(db: PipelineDb): Promise<Map<string, string>> {
  const rows = await db
    .select({ ticker: tables.supplierPassages.ticker, filed: max(tables.supplierPassages.filed) })
    .from(tables.supplierPassages)
    .where(eq(tables.supplierPassages.basis, 'hand'))
    .groupBy(tables.supplierPassages.ticker)
  return new Map(rows.map((r) => [r.ticker, r.filed ?? '']))
}
