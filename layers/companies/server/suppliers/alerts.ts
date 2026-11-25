// The supplier-passage rule: when the judge reads a new tie to a lab or a cloud out of a
// supplier's fresh SEC filing, and the Worker has checked it word for word (review.ts), one
// alert per filing states what the filing says. No model weighs it: the judge only finds the
// passage, and this reads the stored rows.
//
// A filing alerts only when
//   - it was filed in the last FRESH_DAYS,
//   - its passages were read from it (a row a later filing repeats word for word is restamped
//     onto that filing before the judge sees it, and keeps the time it was first seen),
//   - the company was read before this filing (it has hand-read rows, or a document read
//     before the window opened), so a filer added to the reader alerts nothing while its year
//     of filings is read, and
//   - a passage is news: a counterparty and relation no earlier row of the company had, or a
//     figure no earlier row of that tie stated.
// A backfill (the reader's first year of filings, a re-read, a new filer) therefore alerts on
// nothing older than FRESH_DAYS and nothing from a company new to the reader, and one filing
// that ties a company to several labs is one alert. It cites one row per lab its new passages
// name, so the lab filter finds it under each. Ids hash the company and the accession (and the
// lab, for each row after the first), so a re-run writes nothing twice.
//
// Severity starts at info. A filing is notable when a new passage names a tracked lab or cloud
// and states a figure (each figure is already checked to be written in the quote).

import { and, eq, gte, inArray, isNotNull, min } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { compactUsd } from '#layers/core/shared/utils/terminal-format'
import type { PipelineDb } from '#layers/core/server/utils/pipeline-store'
import { writeFindings, type Finding } from '#layers/core/server/pipeline/observation-alerts'
import {
  SUPPLIER_RELATION_LABEL,
  supplierFigureText,
  type SupplierFigure,
  type SupplierRelation,
} from '../../shared/utils/suppliers'
import { SUPPLIER_FILERS, nameKey } from './filers'

export const SUPPLIER_RULE = 'supplier-passage-floor' as const

/** How recent the filing must be. */
export const FRESH_DAYS = 14
/** Quotes the explanation gives before "and N more". */
const QUOTED = 2
const DAY_MS = 86_400_000

type Passage = typeof tables.supplierPassages.$inferSelect
type Doc = Pick<
  typeof tables.supplierDocuments.$inferSelect,
  'accession_no' | 'ticker' | 'form' | 'filed' | 'source_url' | 'fetched_at'
>

const COMPANY = new Map(SUPPLIER_FILERS.map((f) => [f.ticker, f.company]))

const figuresOf = (p: Passage): SupplierFigure[] => JSON.parse(p.figures) as SupplierFigure[]
const figureKey = (f: SupplierFigure) => `${f.unit}:${f.value}`
const tieKey = (p: Passage) => `${p.relation}|${nameKey(p.counterparty)}`
/** A lab or a cloud the counterparty list knows (filers.ts › COUNTERPARTIES). */
const tracked = (p: Passage) =>
  p.relation !== 'concentration' && (p.counterparty_lab !== null || p.counterparty_ticker !== null)

/**
 * Whether `p` was on file before `doc`: seen before the filing was read, or read from an
 * earlier filing (two filings the judge reads in one run don't both count a tie as new).
 */
const before = (p: Passage, doc: Doc) =>
  p.first_seen_at < doc.fetched_at ||
  (p.accession_no !== doc.accession_no &&
    (p.filed < doc.filed || (p.filed === doc.filed && (p.accession_no ?? '') < doc.accession_no)))

/** Pure: the passages of `doc` that are news against the company's earlier rows. */
export function newPassages(doc: Doc, passages: readonly Passage[]): Passage[] {
  const own = passages.filter((p) => p.ticker === doc.ticker)
  const earlier = own.filter((p) => before(p, doc))
  const stated = new Map<string, Set<string>>()
  for (const p of earlier) {
    const seen = stated.get(tieKey(p)) ?? new Set<string>()
    for (const f of figuresOf(p)) seen.add(figureKey(f))
    stated.set(tieKey(p), seen)
  }
  return own.filter((p) => {
    if (p.basis !== 'judge' || p.accession_no !== doc.accession_no) return false
    if (p.first_seen_at < doc.fetched_at) return false
    const seen = stated.get(tieKey(p))
    return !seen || figuresOf(p).some((f) => !seen.has(figureKey(f)))
  })
}

function tieText(p: Passage, company: string): string {
  const figures = figuresOf(p)
    .map((f) => supplierFigureText(f, compactUsd))
    .join(', ')
  const tie =
    p.relation === 'concentration'
      ? `a customer it doesn’t name (${p.counterparty})`
      : `${company} ${SUPPLIER_RELATION_LABEL[p.relation as SupplierRelation]} ${p.counterparty}`
  return figures ? `${tie} (${figures})` : tie
}

const names = (values: readonly string[]) =>
  values.length <= 2
    ? values.join(' and ')
    : `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`

/** The passage a group leads with: a tracked tie with a figure, else a tracked tie, else the first. */
const leadOf = (group: readonly Passage[]) =>
  group.find((p) => tracked(p) && figuresOf(p).length > 0) ?? group.find(tracked) ?? group[0]!

/** A cited row's payload: the filing, the passages it covers, and the one it leads with. */
function citedAfter(doc: Doc, company: string, group: readonly Passage[]) {
  const first = leadOf(group)
  const counterparties = [...new Set(group.map((p) => p.counterparty))]
  const labs = [...new Set(group.flatMap((p) => (p.counterparty_lab ? [p.counterparty_lab] : [])))]
  return {
    summary: `${company} · ${doc.form} · ${doc.filed} · ${names(counterparties)} · ${group.length} new ${group.length === 1 ? 'passage' : 'passages'}`,
    ticker: doc.ticker,
    company,
    form: doc.form,
    filed: doc.filed,
    accession_no: doc.accession_no,
    period: first.period,
    passages: group.length,
    counterparties: counterparties.join(', '),
    labs: labs.join(', ') || null,
    relation: first.relation,
    counterparty: first.counterparty,
    figures: figuresOf(first)
      .map((f) => supplierFigureText(f, compactUsd))
      .join(', '),
    quote: first.quote,
  }
}

function finding(doc: Doc, news: readonly Passage[]): Finding {
  const company = COMPANY.get(doc.ticker) ?? news[0]!.company_name
  const notable = news.some((p) => tracked(p) && figuresOf(p).length > 0)
  const first = leadOf(news)
  const provider = (first.counterparty_lab ?? 'other') as Finding['provider']
  const counterparties = [...new Set(news.map((p) => p.counterparty))]
  const labs = [...new Set(news.flatMap((p) => (p.counterparty_lab ? [p.counterparty_lab] : [])))]
  const filing = `${company}’s ${doc.form}, filed ${doc.filed}`
  const headline =
    news.length === 1
      ? `${filing}, says ${tieText(first, company)}`
      : `${filing}, names ${names(counterparties)} in ${news.length} new passages`
  const quotes = news
    .slice(0, QUOTED)
    .map((p) => `“${p.quote}”`)
    .join(' ')
  const more = news.length > QUOTED ? ` And ${news.length - QUOTED} more.` : ''
  return {
    rule: SUPPLIER_RULE,
    entity_type: 'supplier_passage',
    entity_key: `supplier_passage:${doc.ticker.toLowerCase()}`,
    provider,
    period: doc.accession_no,
    change_type: 'added',
    before: null,
    after: citedAfter(doc, company, news),
    also: labs
      .filter((lab) => lab !== provider)
      .map((lab) => ({
        provider: lab as Finding['provider'],
        after: citedAfter(
          doc,
          company,
          news.filter((p) => p.counterparty_lab === lab),
        ),
      })),
    headline,
    explanation: [
      `${filing} (accession ${doc.accession_no}), says ${news.map((p) => tieText(p, company)).join(', and ')}.`,
      `${quotes}${more}`,
      'The judge found each passage in the filing, and the Worker checked it word for word against the stored copy, with every figure written in the quote.',
      `Rule-based: one alert per filing from the last ${FRESH_DAYS} days with a tie or figure the company’s earlier rows didn’t state. A figure for a tracked lab or cloud makes it notable.`,
    ].join(' '),
    source_url: doc.source_url,
    fetched_at: doc.fetched_at,
    severity: notable ? 'notable' : 'info',
  }
}

/**
 * Pure: one finding per fresh filing with news. `firstRead` is each company's earliest
 * document read; a company with hand-read rows counts as read before any filing.
 */
export function supplierFindings(
  docs: readonly Doc[],
  passages: readonly Passage[],
  firstRead: ReadonlyMap<string, string>,
  now: Date,
): Finding[] {
  const windowFrom = new Date(now.getTime() - FRESH_DAYS * DAY_MS).toISOString()
  const freshFrom = windowFrom.slice(0, 10)
  const hand = new Set(passages.filter((p) => p.basis === 'hand').map((p) => p.ticker))
  return docs
    .filter((d) => d.filed >= freshFrom)
    .filter((d) => hand.has(d.ticker) || (firstRead.get(d.ticker) ?? windowFrom) < windowFrom)
    .flatMap((d) => {
      const news = newPassages(d, passages)
      return news.length ? [finding(d, news)] : []
    })
}

export async function writeSupplierAlerts(
  db: PipelineDb,
  now = new Date(),
): Promise<{ written: number; findings: number }> {
  const freshFrom = new Date(now.getTime() - FRESH_DAYS * DAY_MS).toISOString().slice(0, 10)
  const docs = await db
    .select({
      accession_no: tables.supplierDocuments.accession_no,
      ticker: tables.supplierDocuments.ticker,
      form: tables.supplierDocuments.form,
      filed: tables.supplierDocuments.filed,
      source_url: tables.supplierDocuments.source_url,
      fetched_at: tables.supplierDocuments.fetched_at,
    })
    .from(tables.supplierDocuments)
    .where(
      and(
        eq(tables.supplierDocuments.status, 'read'),
        isNotNull(tables.supplierDocuments.judged_at),
        gte(tables.supplierDocuments.filed, freshFrom),
      ),
    )
  if (docs.length === 0) return { written: 0, findings: 0 }
  const tickers = [...new Set(docs.map((d) => d.ticker))]
  const [passages, reads] = await Promise.all([
    db
      .select()
      .from(tables.supplierPassages)
      .where(inArray(tables.supplierPassages.ticker, tickers)),
    db
      .select({
        ticker: tables.supplierDocuments.ticker,
        first: min(tables.supplierDocuments.fetched_at),
      })
      .from(tables.supplierDocuments)
      .where(inArray(tables.supplierDocuments.ticker, tickers))
      .groupBy(tables.supplierDocuments.ticker),
  ])
  const firstRead = new Map(reads.flatMap((r) => (r.first ? [[r.ticker, r.first] as const] : [])))
  const findings = supplierFindings(docs, passages, firstRead, now)
  return { written: await writeFindings(db, findings, now), findings: findings.length }
}
