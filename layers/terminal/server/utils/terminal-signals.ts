// The /api/signals payload: the registry joined to the newest run's
// statistics, and the forward calls with their scores. It reads
// signal_results, signal_runs, forward_calls and forward_call_scores, never
// market_bars, so no price can reach it (layers/terminal/test/signals-private.test.ts).

import { count } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import {
  HOLDOUT_FRACTION,
  MIN_SAMPLE,
  SIGNAL_HORIZONS,
  type SignalHorizon,
  type SignalSeriesView,
  type SignalStat,
  type SignalsData,
} from '../../shared/utils/signals'
import { GRID_AREAS } from '../../shared/utils/grid-load'
import { PRINT_ENTITIES } from '../../shared/utils/prints'
import { labName } from '../../shared/utils/terminal-labs'
import type { PipelineDb } from '../pipeline/store'
import { forwardCallViews } from '../signals/forward-calls'
import { SIGNALS, sourceLabel } from '../signals/registry'
import { latestRun, type SeriesCoverage } from '../signals/run'
import type { QueryContext } from './terminal-db'

export const SIGNALS_METHOD =
  'For each series and each ticker it is expected to lead: the correlation between the series’ change each period and the ticker’s return over the next 1, 5, 20 and 60 trading days less SPY’s, measured from the first session after the figure was public. For event series (launches, price cuts, filings), the mean of that abnormal return from the close before each event. The newest third of each series is held out of sample. P-values shrink the sample where returns overlap. Prices are Databento daily closes, split-adjusted, without dividends, used internally and never published.'

export const FORWARD_CALLS_RULE =
  'Each call is dated and holds every method we ran, with its inputs as they stood, and is never edited. It is scored against the 10-Q or 10-K filed after it: each method’s error, and whether the actual landed between the lowest and highest non-control estimate. Research, not investment advice.'

export const SIGNALS_CREDIT =
  'Market data: Databento (internal use). Only derived statistics are shown.'

/** The newest run's id and the forward calls and scores held, for the payload cache key. */
export async function signalsStamp(db: PipelineDb): Promise<string> {
  const [run, [calls], [scores]] = await Promise.all([
    latestRun(db),
    db.select({ n: count() }).from(tables.forwardCalls),
    db.select({ n: count() }).from(tables.forwardCallScores),
  ])
  return `${run?.id ?? 'none'}:${calls?.n ?? 0}:${scores?.n ?? 0}`
}

const statOf = (row: typeof tables.signalResults.$inferSelect | undefined): SignalStat =>
  row
    ? {
        status: row.status === 'ok' ? 'ok' : 'thin',
        n: row.n,
        estimate: row.estimate,
        t_stat: row.t_stat,
        p_value: row.p_value,
      }
    : { status: 'thin', n: 0, estimate: null, t_stat: null, p_value: null }

function entityLabel(kind: string, id: string): string {
  if (kind === 'lab') return labName(id)
  if (kind === 'grid') return GRID_AREAS.find((a) => a.ba === id)?.short ?? id
  if (kind === 'supplier') return PRINT_ENTITIES.find((e) => e.id === id)?.name ?? id
  return id
}

export async function querySignals(db: PipelineDb, ctx: QueryContext): Promise<SignalsData> {
  const [run, results, forward] = await Promise.all([
    latestRun(db),
    db.select().from(tables.signalResults),
    forwardCallViews(db),
  ])
  let coverage: Record<string, SeriesCoverage> = {}
  try {
    coverage = run ? (JSON.parse(run.coverage) as Record<string, SeriesCoverage>) : {}
  } catch {
    coverage = {}
  }
  const key = (r: { series_id: string; ticker: string; horizon: number; sample: string }) =>
    `${r.series_id}|${r.ticker}|${r.horizon}|${r.sample}`
  const byKey = new Map(results.map((r) => [key(r), r]))

  const series: SignalSeriesView[] = SIGNALS.map((def) => {
    const cov = coverage[def.id]
    return {
      id: def.id,
      label: def.label,
      entity: { ...def.entity, label: entityLabel(def.entity.kind, def.entity.id) },
      tickers: [...def.tickers],
      source: sourceLabel(def.source),
      transform: def.transform,
      frequency: def.frequency,
      test: def.test,
      history_from: def.history_from,
      observations: cov?.observations ?? 0,
      from: cov?.from ?? null,
      to: cov?.to ?? null,
      error: cov?.error ?? null,
      cells: def.tickers.flatMap((ticker) =>
        SIGNAL_HORIZONS.map((horizon: SignalHorizon) => ({
          ticker,
          horizon,
          in: statOf(byKey.get(key({ series_id: def.id, ticker, horizon, sample: 'in' }))),
          out: statOf(byKey.get(key({ series_id: def.id, ticker, horizon, sample: 'out' }))),
        })),
      ),
    }
  })

  const tests = results.filter((r) => r.status === 'ok').length
  return {
    as_of: run?.finished_at ?? null,
    computed_at: ctx.now().toISOString(),
    run: run
      ? {
          started_at: run.started_at,
          finished_at: run.finished_at,
          status: run.status === 'ok' ? 'ok' : 'failed',
          detail: run.detail,
        }
      : null,
    prices_through: run?.prices_through ?? null,
    tests,
    bonferroni_p: tests > 0 ? 0.05 / tests : null,
    horizons: SIGNAL_HORIZONS,
    min_sample: MIN_SAMPLE,
    holdout: HOLDOUT_FRACTION,
    series,
    forward_calls: forward,
    forward_rule: FORWARD_CALLS_RULE,
    method: SIGNALS_METHOD,
    credit: SIGNALS_CREDIT,
  }
}
