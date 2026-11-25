// The call guidance /api/call-guidance serves: each figure a company guided, with
// the filing that later settled it. A figure in the release and on the call is one
// row with both sources. As of T it counts what was first seen by T.

import { and, inArray, lte, sql } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'

import * as tables from '#server/db/schema'
import { NO_FILING_DAYS, unscorable } from '../calls/actuals'
import { CALL_COMPANIES, curatedCalls } from '../calls/curated'
import { CALL_SOURCES } from '../calls/ingest'
import { daysBetween, periodLabel, reportedQuarter } from '../calls/periods'
import { filingUrl } from '../exposure/series'

export const CALL_GUIDANCE_RULE =
  'What management guided, read from the company’s earnings release and its own transcript or remarks, or from our transcript of its replay, and scored against the figure a later 10-Q or 10-K filed for the same measure and period. A range is met when the filed figure is inside it, a single figure within 5% (half a point for a percentage). Error is the filed figure less the guided midpoint, over the midpoint. A segment line, an AI figure or a non-GAAP margin is listed but not scored: no filing we read states it. Quotes are at most 25 words. Not investment advice.'

/** Statements in the default (all-company) view, newest call first. */
export const CALL_GUIDANCE_LIMIT = 60

// A figure in a release and on the call is one statement; the transcript's quote reads best.
const QUOTE_ORDER: readonly CallSource[] = ['transcript', 'remarks', 'audio', 'exhibit']

/** The cache key's data stamp: statements and resolutions held. */
export async function callGuidanceStamp(db: PipelineDb): Promise<string> {
  const [[g], [r]] = await Promise.all([
    db
      .select({
        n: sql<number>`count(*)`,
        last: sql<string | null>`max(${tables.filedGuidance.first_seen_at})`,
      })
      .from(tables.filedGuidance)
      .where(inArray(tables.filedGuidance.source, [...CALL_SOURCES])),
    db.select({ n: sql<number>`count(*)` }).from(tables.guidanceResolutions),
  ])
  return `${g?.n ?? 0}:${g?.last ?? ''}:${r?.n ?? 0}`
}

export function callTally(rows: readonly CallStatement[]): CallTally {
  const n = (s: CallStatement['state']) => rows.filter((r) => r.state === s).length
  const dollars = rows.filter(
    (r) => (r.state === 'met' || r.state === 'above' || r.state === 'below') && r.unit === 'USD',
  )
  return {
    statements: rows.length,
    scored: n('met') + n('above') + n('below'),
    met: n('met'),
    above: n('above'),
    below: n('below'),
    open: n('open'),
    unscored: n('unscored'),
    median_abs_error: dollars.length ? middle(dollars.map((r) => Math.abs(r.error_share!))) : null,
  }
}

/**
 * Which companies a read covers: every company, one ticker, or the tickers a lab's
 * listed ties name (the shell's /api/call-guidance?lab=, which knows the ties).
 */
export type CallScope = { ticker: string } | { lab: LabId; tickers: readonly string[] } | null

export async function queryCallGuidance(
  db: PipelineDb,
  ctx: QueryContext,
  scope: CallScope = null,
): Promise<CallGuidanceData> {
  const at = ctx.at
  const g = tables.filedGuidance
  const ticker = scope && 'ticker' in scope ? scope.ticker : null
  const lab = scope && 'lab' in scope ? scope.lab : null
  const tickers = scope === null ? null : 'ticker' in scope ? [scope.ticker] : scope.tickers
  // inArray on an empty list is no row, not every row.
  const only = (column: SQLiteColumn) =>
    tickers === null ? undefined : tickers.length ? inArray(column, [...tickers]) : sql`0`
  const [rows, resolutions, docs] = await Promise.all([
    db
      .select()
      .from(g)
      .where(
        and(
          inArray(g.source, [...CALL_SOURCES]),
          only(g.ticker),
          at ? lte(g.first_seen_at, at) : undefined,
        ),
      ),
    db
      .select()
      .from(tables.guidanceResolutions)
      .where(
        and(
          only(tables.guidanceResolutions.ticker),
          at ? lte(tables.guidanceResolutions.first_seen_at, at) : undefined,
        ),
      ),
    db
      .select({
        ticker: tables.callDocuments.ticker,
        kind: tables.callDocuments.kind,
        status: tables.callDocuments.status,
        produced_by: tables.callDocuments.produced_by,
        id: tables.callDocuments.id,
      })
      .from(tables.callDocuments)
      .where(at ? lte(tables.callDocuments.first_seen_at, at) : undefined),
  ])
  const today = (at ?? ctx.now().toISOString()).slice(0, 10)
  const byGuidance = new Map(
    [...resolutions]
      .sort((a, b) => a.filed.localeCompare(b.filed))
      .reverse()
      .map((r) => [r.guidance_id, r]),
  )
  const producedBy = new Map(docs.map((d) => [d.id, d.produced_by]))

  // One statement per company, call, metric, period and figure.
  const groups = new Map<string, (typeof rows)[number][]>()
  for (const r of rows) {
    const key = [r.ticker, r.filed, r.metric, r.segment, r.unit, r.period_end, r.low, r.high].join(
      '|',
    )
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  const statements: CallStatement[] = []
  for (const group of groups.values()) {
    group.sort(
      (a, b) =>
        QUOTE_ORDER.indexOf(a.source as CallSource) - QUOTE_ORDER.indexOf(b.source as CallSource),
    )
    const lead = group[0]!
    const c = CALL_COMPANIES.get(lead.ticker)
    if (!c) continue
    const resolution = group.map((r) => byGuidance.get(r.id)).find(Boolean) ?? null
    const reason = unscorable(lead.ticker, lead)
    let state: CallStatement['state'] = 'open'
    if (resolution) state = resolution.state as CallStatement['state']
    else if (reason) state = 'unscored'
    else if (lead.period_end && daysBetween(lead.period_end, today) > NO_FILING_DAYS)
      state = 'unscored'
    statements.push({
      id: lead.id,
      ticker: lead.ticker,
      company: c.company,
      call_date: lead.filed,
      call_period: periodLabel(c.fy_end_month, reportedQuarter(c.fy_end_month, lead.filed)),
      metric: lead.metric as CallStatement['metric'],
      segment: lead.segment,
      basis: lead.basis as CallStatement['basis'],
      unit: lead.unit as CallStatement['unit'],
      bound: lead.bound as CallStatement['bound'],
      period: periodLabel(c.fy_end_month, {
        fiscal_year: lead.fiscal_year,
        quarter: lead.fiscal_quarter,
      }),
      period_end: lead.period_end ?? '',
      low: lead.low,
      high: lead.high,
      quote: lead.sentence,
      speaker: lead.speaker,
      sources: group.map((r) => ({
        source: r.source as CallSource,
        url: r.source_url,
        page_url: r.page_url,
        produced_by: r.call_document_id ? (producedBy.get(r.call_document_id) ?? null) : null,
        page: r.page,
        at_ms: r.at_ms,
      })),
      first_seen_at: group.map((r) => r.first_seen_at).sort()[0]!,
      state,
      reason: resolution
        ? null
        : (reason ??
          (state === 'unscored' ? 'No 10-Q or 10-K we read states this period’s figure.' : null)),
      actual: resolution
        ? {
            value: resolution.actual,
            concept: resolution.concept,
            form: resolution.form,
            filed: resolution.filed,
            accession_no: resolution.accession_no,
            filing_url: filingUrl(c.cik, resolution.accession_no),
            first_seen_at: resolution.first_seen_at,
          }
        : null,
      error_share: resolution?.error_share ?? null,
    })
  }
  statements.sort(
    (a, b) =>
      b.call_date.localeCompare(a.call_date) ||
      a.ticker.localeCompare(b.ticker) ||
      a.period_end.localeCompare(b.period_end) ||
      a.metric.localeCompare(b.metric),
  )

  const companies: CallCoverage[] = curatedCalls.companies
    .filter((c) => tickers === null || tickers.includes(c.ticker))
    .map((c) => {
      const mine = docs.filter((d) => d.ticker === c.ticker && d.status === 'read')
      const count = (kind: string) => mine.filter((d) => d.kind === kind).length
      const own = statements.filter((s) => s.ticker === c.ticker)
      return {
        ticker: c.ticker,
        company: c.company,
        posts: c.posts,
        ir_url: c.ir_url,
        documents: {
          exhibit: count('exhibit'),
          transcript: count('transcript'),
          remarks: count('remarks'),
          audio: count('audio'),
        },
        statements: own.length,
        scored: own.filter((s) => s.state === 'met' || s.state === 'above' || s.state === 'below')
          .length,
        gap: c.gap,
      }
    })

  const limit = scope ? statements.length : CALL_GUIDANCE_LIMIT
  return {
    as_of: ctx.as_of,
    computed_at: ctx.now().toISOString(),
    rule: CALL_GUIDANCE_RULE,
    ticker,
    lab,
    statements: statements.slice(0, limit),
    omitted: Math.max(0, statements.length - limit),
    tally: callTally(statements),
    companies,
  }
}
