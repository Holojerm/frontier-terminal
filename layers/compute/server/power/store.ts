// The stored power table: the hand-read rows it starts from, the rows a reader
// sees, and what a newly read filing does to the rows before it.

import { and, count, desc, eq, isNull, max } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import {
  curatedPowerSites,
  type CuratedPowerSites,
  type PowerBasis,
} from '../../shared/utils/power-sites'
import curated from '../curated/power-sites.json'
import { contentHash, accessionOf } from '#layers/core/server/utils/contracts/keys'
import {
  chunk,
  D1_MAX_BOUND_PARAMS,
  runStatements,
  type PipelineDb,
} from '#layers/core/server/utils/pipeline-store'
import { contains } from '#layers/core/server/pipeline/document-text'

export type StoredTie = typeof tables.powerSiteTies.$inferSelect
type Insert = typeof tables.powerSiteTies.$inferInsert

/** Forms a filer restates in full each period: a row its next one drops has ended. */
export const PERIODIC_FORMS: readonly string[] = ['10-Q', '10-K', '20-F']

/** The row id: the same five fields the export has always keyed ties on. */
export const tieId = (t: {
  site: string
  role: string
  company_name: string
  source_url: string
  quote: string
}) =>
  contentHash({
    site: t.site,
    role: t.role,
    company: t.company_name,
    source_url: t.source_url,
    quote: t.quote,
  })

/** The filer's CIK in an EDGAR archive URL, unpadded, or null. */
function cikOf(url: string): string | null {
  const m = /\/Archives\/edgar\/data\/(\d+)\//.exec(url)
  return m ? String(Number(m[1])) : null
}

const isExhibit = (url: string) => /\/[^/]*ex(?:hibit)?-?\d[^/]*$/i.test(url)

/**
 * The SEC form of a hand-read filing's main document, from the title a person
 * gave it ("TeraWulf Inc. Form 10-Q for …"); null for an exhibit or a page
 * off EDGAR, which no later filing ends.
 */
export function formOf(url: string, title: string | null): string | null {
  if (!cikOf(url) || isExhibit(url) || !title) return null
  return /\bForm (10-Q|10-K|20-F|S-1\/A|S-1|8-K|6-K)\b/.exec(title)?.[1] ?? null
}

/** Every row the hand-read file holds, as stored: the grid where a page names it, then each company. */
export function handTies(table: CuratedPowerSites = curatedPowerSites.parse(curated)): Insert[] {
  return table.sites.flatMap((s) => {
    // A grid row has no title of its own: it takes the form and date of a link on the same page.
    const byUrl = new Map(s.links.map((l) => [l.source_url, l]))
    const base = (source_url: string, fetched_at: string) => {
      const link = byUrl.get(source_url)
      const form = formOf(source_url, link?.source_title ?? null)
      return {
        basis: 'hand' as PowerBasis,
        accession_no: accessionOf(source_url),
        form,
        filed: form ? (link?.published ?? null) : null,
        first_seen_at: fetched_at,
        ended_at: null,
        ended_by: null,
        source_url,
        fetched_at,
      }
    }
    const grid: Insert[] = s.grid
      ? [
          {
            id: tieId({
              site: s.site,
              role: 'grid',
              company_name: s.grid.name,
              source_url: s.grid.source_url,
              quote: s.grid.quote,
            }),
            site: s.site,
            role: 'grid',
            company_name: s.grid.name,
            parent: null,
            ticker: null,
            unlisted: null,
            mw: null,
            mw_meaning: null,
            source_title: null,
            publisher: null,
            published: null,
            quote: s.grid.quote,
            ...base(s.grid.source_url, s.grid.fetched_at),
          },
        ]
      : []
    return [
      ...grid,
      ...s.links.map((l) => ({
        id: tieId({
          site: s.site,
          role: l.role,
          company_name: l.company,
          source_url: l.source_url,
          quote: l.quote,
        }),
        site: s.site,
        role: l.role,
        company_name: l.company,
        parent: l.parent,
        ticker: l.ticker,
        unlisted: l.unlisted,
        mw: l.mw,
        mw_meaning: l.mw_meaning,
        source_title: l.source_title,
        publisher: l.publisher,
        published: l.published,
        quote: l.quote,
        ...base(l.source_url, l.fetched_at),
      })),
    ]
  })
}

/** Rows per insert under D1's bound-parameter limit: 22 columns each. */
const TIE_ROWS_PER_INSERT = Math.floor(D1_MAX_BOUND_PARAMS / 22)

/** Copy the hand-read rows in, once: a row already stored, ended or not, is left as it is. */
export async function seedHandTies(db: PipelineDb, rows: Insert[] = handTies()): Promise<number> {
  const [stored] = await db
    .select({ n: count() })
    .from(tables.powerSiteTies)
    .where(eq(tables.powerSiteTies.basis, 'hand'))
  if ((stored?.n ?? 0) >= rows.length) return 0
  await runStatements(
    db,
    chunk(rows, TIE_ROWS_PER_INSERT).map((part) =>
      db.insert(tables.powerSiteTies).values(part).onConflictDoNothing(),
    ),
  )
  return rows.length - (stored?.n ?? 0)
}

export async function insertTies(db: PipelineDb, rows: Insert[]): Promise<void> {
  await runStatements(
    db,
    chunk(rows, TIE_ROWS_PER_INSERT).map((part) =>
      db.insert(tables.powerSiteTies).values(part).onConflictDoNothing(),
    ),
  )
}

/** The rows no later filing has ended, newest first. */
export async function currentTies(db: PipelineDb, site?: string): Promise<StoredTie[]> {
  return db
    .select()
    .from(tables.powerSiteTies)
    .where(
      and(
        isNull(tables.powerSiteTies.ended_at),
        site ? eq(tables.powerSiteTies.site, site) : undefined,
      ),
    )
    .orderBy(desc(tables.powerSiteTies.published), tables.powerSiteTies.first_seen_at)
}

/**
 * Moves whenever a row is added, restamped or ended, and whenever a document
 * is stored or settled (a gap counts the filings waiting for a site).
 */
export async function powerTiesStamp(db: PipelineDb): Promise<string> {
  const [[row], [docs]] = await Promise.all([
    db
      .select({
        n: count(),
        fetched: max(tables.powerSiteTies.fetched_at),
        ended: max(tables.powerSiteTies.ended_at),
      })
      .from(tables.powerSiteTies),
    db
      .select({ n: count(), judged: max(tables.powerSiteDocuments.judged_at) })
      .from(tables.powerSiteDocuments),
  ])
  return `${row?.n ?? 0}:${row?.fetched ?? ''}:${row?.ended ?? ''}:${docs?.n ?? 0}:${docs?.judged ?? ''}`
}

/** A filing's main document as the restamp and settle rules see it. */
export interface PowerDocumentRef {
  document_id: string
  site: string
  accession_no: string
  cik: string
  /** The form when the file is the filing's main document, else null (an exhibit). */
  form: string | null
  filed: string
  source_url: string
  fetched_at: string
  source_title: string
  publisher: string
}

/** Rows of the same site from an earlier main document of the same filer and form. */
const earlier = (rows: StoredTie[], doc: PowerDocumentRef) =>
  doc.form === null
    ? []
    : rows.filter(
        (r) =>
          r.form === doc.form &&
          r.filed !== null &&
          r.filed < doc.filed &&
          cikOf(r.source_url) === doc.cik,
      )

/**
 * A row whose quote is in a later filing of the same form now cites that
 * filing. Run when a document is read, before the judge sees it, so a sentence
 * a filer repeats word for word stays current without a reading.
 */
export async function restampTies(
  db: PipelineDb,
  doc: PowerDocumentRef,
  text: string,
): Promise<number> {
  const rows = earlier(await currentTies(db, doc.site), doc).filter((r) => contains(text, r.quote))
  await runStatements(
    db,
    rows.map((r) =>
      db
        .update(tables.powerSiteTies)
        .set({
          source_url: doc.source_url,
          fetched_at: doc.fetched_at,
          filed: doc.filed,
          accession_no: doc.accession_no,
          // A grid row has no title, publisher or date of its own.
          ...(r.role === 'grid'
            ? {}
            : { source_title: doc.source_title, publisher: doc.publisher, published: doc.filed }),
        })
        .where(eq(tables.powerSiteTies.id, r.id)),
    ),
  )
  return rows.length
}

/**
 * Settle a document for a site once nothing more will be read from it: rows
 * of that site from an earlier periodic filing of the same filer and form
 * whose quote it no longer has have ended. A 10-Q restates the filer's sites,
 * so a sentence it drops is no longer the filer's word; an 8-K, an exhibit or
 * a prospectus states one moment and ends nothing.
 */
export async function settleDocument(
  db: PipelineDb,
  doc: PowerDocumentRef,
  text: string,
  now: string,
): Promise<number> {
  const ended =
    doc.form && PERIODIC_FORMS.includes(doc.form)
      ? earlier(await currentTies(db, doc.site), doc).filter((r) => !contains(text, r.quote))
      : []
  await runStatements(db, [
    ...ended.map((r) =>
      db
        .update(tables.powerSiteTies)
        .set({ ended_at: now, ended_by: doc.accession_no })
        .where(eq(tables.powerSiteTies.id, r.id)),
    ),
    db
      .update(tables.powerSiteDocuments)
      .set({ judged_at: now })
      .where(
        and(
          eq(tables.powerSiteDocuments.document_id, doc.document_id),
          eq(tables.powerSiteDocuments.site, doc.site),
        ),
      ),
  ])
  return ended.length
}
