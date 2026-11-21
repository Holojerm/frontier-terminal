// The hyperscaler exposure payload: every series built from filed_facts
// (layers/companies/server/exposure/series.ts), the filers they come from, and
// the figures the filings don't tag. Read-only.
//
// As of T it counts the facts filed before T's UTC day. That is event time,
// not the store's knowledge time the other routes use: a filed fact was public
// from its filing date whether or not we had read it yet, so the history goes
// back to 2020 even though the store's first snapshot is from 2026. Counting
// from the day after the filing date keeps a filing accepted late on T's own
// day out of T.

import { and, lt, ne } from 'drizzle-orm'

import type { ExposureData, ExposureTicker } from '../../shared/utils/terminal-exposure'

import * as tables from '#server/db/schema'
import { readState } from '../exposure/ingest'
import {
  EXPOSURE_GAPS,
  FILER_NAMES,
  FISCAL_YEAR_END,
  buildSeries,
  textSeries,
  type StoredFact,
  type StoredTextFact,
} from '../exposure/series'
import type { PipelineDb } from '#layers/core/server/utils/pipeline-store'
import type { QueryContext } from '#layers/core/server/utils/terminal-db'

export const EXPOSURE_METHOD =
  'filed facts: every XBRL fact filed before the UTC day of as_of, each quarter from the newest of those filings. A fact counts from the day after its filing date, whenever we read it, so source_url and fetched_at can postdate as_of.'

export const EXPOSURE_RULE =
  'Filed XBRL facts (the SEC’s tagged financial data), and before Amazon tagged Anthropic, the figures its filings stated in words, each quoted. Each is linked to its filing. Every series is the filer’s own number, never the lab’s. As of a past instant, a fact counts from the day after its filing date.'

/** UTC day of an instant: facts filed before it count at that instant. */
export const filedBefore = (at: string) => at.slice(0, 10)

/**
 * Every stored fact filed before the UTC day of `at`, or all of them. The
 * concept reads behind call guidance (basis `companyconcept`, calls/actuals.ts)
 * cover forty more companies and are left out: no exposure series reads them.
 */
export function filedFactsAt(db: PipelineDb, at: string | null): Promise<StoredFact[]> {
  return db
    .select({
      ticker: tables.filedFacts.ticker,
      concept: tables.filedFacts.concept,
      dims: tables.filedFacts.dims,
      start: tables.filedFacts.start,
      end: tables.filedFacts.end,
      value: tables.filedFacts.value,
      unit: tables.filedFacts.unit,
      form: tables.filedFacts.form,
      filed: tables.filedFacts.filed,
      accession_no: tables.filedFacts.accession_no,
      cik: tables.filedFacts.cik,
      source_url: tables.filedFacts.source_url,
      fetched_at: tables.filedFacts.fetched_at,
    })
    .from(tables.filedFacts)
    .where(
      and(
        ne(tables.filedFacts.basis, 'companyconcept'),
        at ? lt(tables.filedFacts.filed, filedBefore(at)) : undefined,
      ),
    )
}

/** Every figure a filer stated about a lab in words, filed before the UTC day of `at`, or all of them. */
export async function textFactsAt(db: PipelineDb, at: string | null): Promise<StoredTextFact[]> {
  const t = tables.filedTextFacts
  const rows = await db
    .select({
      ticker: t.ticker,
      lab: t.lab,
      metric: t.metric,
      concept: t.metric,
      dims: t.lab,
      start: t.start,
      end: t.end,
      value: t.value,
      unit: t.unit,
      form: t.form,
      filed: t.filed,
      accession_no: t.accession_no,
      cik: t.cik,
      qualifier: t.qualifier,
      sentence: t.sentence,
      source_url: t.source_url,
      fetched_at: t.fetched_at,
    })
    .from(t)
    .where(at ? lt(t.filed, filedBefore(at)) : undefined)
  return rows as StoredTextFact[]
}

export async function queryExposure(db: PipelineDb, ctx: QueryContext): Promise<ExposureData> {
  const at = ctx.at
  if (at) {
    ctx.notes.method.add(EXPOSURE_METHOD)
    ctx.notes.eventTime = true
  }
  const [facts, text, state] = await Promise.all([
    filedFactsAt(db, at),
    textFactsAt(db, at),
    readState(db, null),
  ])
  return {
    as_of: ctx.as_of,
    computed_at: ctx.now().toISOString(),
    rule: EXPOSURE_RULE,
    filers: ctx.filedFactSources.map((f) => {
      const ticker = f.ticker as ExposureTicker
      const s = state.get(f.ticker)
      return {
        ticker,
        name: FILER_NAMES[ticker],
        cik: f.cik,
        source_url: f.url,
        instances: f.instances,
        fiscal_year_end: FISCAL_YEAR_END[ticker],
        caveat: f.caveat,
        last_read_at: s?.last_read_at ?? null,
        instances_read: s?.instances_read ?? 0,
      }
    }),
    series: [...buildSeries(facts), ...textSeries(text)],
    gaps: [...EXPOSURE_GAPS],
  }
}
