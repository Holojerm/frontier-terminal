// The hyperscaler exposure payload: every series built from filed_facts
// (layers/terminal/server/exposure/series.ts), the filers they come from, and
// the figures the filings don't tag. Read-only.
//
// As of T it counts the facts filed before T's UTC day. That is event time,
// not the store's knowledge time the other routes use: a filed fact was public
// from its filing date whether or not we had read it yet, so the history goes
// back to 2020 even though the store's first snapshot is from 2026. Counting
// from the day after the filing date keeps a filing accepted late on T's own
// day out of T.

import { lt } from 'drizzle-orm'

import type { ExposureData, ExposureTicker } from '../../shared/utils/terminal-exposure'

import * as tables from '#server/db/schema'
import { readState } from '../exposure/ingest'
import { EXPOSURE_GAPS, FILER_NAMES, FISCAL_YEAR_END, buildSeries } from '../exposure/series'
import type { PipelineDb } from '../pipeline/store'
import type { QueryContext } from './terminal-db'

export const EXPOSURE_METHOD =
  'filed facts: every XBRL fact filed before the UTC day of as_of, each quarter from the newest of those filings. A fact counts from the day after its filing date, whenever we read it, so source_url and fetched_at can postdate as_of.'

export const EXPOSURE_RULE =
  'Filed XBRL facts only (the SEC’s tagged financial data), each linked to its filing. Every series is the filer’s own number, never the lab’s. As of a past instant, a fact counts from the day after its filing date.'

/** UTC day of an instant: facts filed before it count at that instant. */
export const filedBefore = (at: string) => at.slice(0, 10)

export async function queryExposure(db: PipelineDb, ctx: QueryContext): Promise<ExposureData> {
  const at = ctx.at
  if (at) {
    ctx.notes.method.add(EXPOSURE_METHOD)
    ctx.notes.eventTime = true
  }
  const [facts, state] = await Promise.all([
    db
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
      .where(at ? lt(tables.filedFacts.filed, filedBefore(at)) : undefined),
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
    series: buildSeries(facts),
    gaps: [...EXPOSURE_GAPS],
  }
}
