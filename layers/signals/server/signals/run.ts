// One harness run: read the price panel and every registered series, score
// each against its tickers, and replace signal_results whole. A series that
// fails to load is recorded with its error and scored as nothing, never
// dropped from the page.

import { desc, max } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import {
  changesOf,
  eventDays,
  eventStudy,
  leadLag,
  resample,
  type CellResult,
  type Period,
} from './harness'
import { readPanel, type PricePanel } from './market'
import { SIGNALS, type SignalDef } from './registry'
import { createLoader } from './sources'

export const BENCHMARK = 'SPY'

export const PERIOD_OF: Record<Exclude<SignalFrequency, 'event'>, Period> = {
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
}

export interface SeriesCoverage {
  observations: number
  from: string | null
  to: string | null
  error: string | null
}

export interface ScoredSeries {
  def: SignalDef
  coverage: SeriesCoverage
  cells: CellResult[]
}

/** Score one series. Pure given its loaded data and the panel. */
export async function scoreSeries(
  def: SignalDef,
  load: ReturnType<typeof createLoader>,
  panel: PricePanel,
): Promise<ScoredSeries> {
  try {
    const loaded = await load(def.source)
    if (loaded.kind === 'events') {
      const days = eventDays(loaded.events)
      return {
        def,
        coverage: {
          observations: days.length,
          from: days[0]?.date ?? null,
          to: days.at(-1)?.date ?? null,
          error: null,
        },
        cells: eventStudy(loaded.events, panel, def.tickers, BENCHMARK, def.signed ?? false),
      }
    }
    if (def.frequency === 'event') throw new Error('an event series read as points')
    const period = PERIOD_OF[def.frequency]
    const points = resample(loaded.points, period, def.aggregate ?? 'last')
    const changes = changesOf(points, def.transform, period, def.available_after_days)
    return {
      def,
      coverage: {
        observations: points.length,
        from: points[0]?.date ?? null,
        to: points.at(-1)?.date ?? null,
        error: null,
      },
      cells: leadLag(changes, panel, def.tickers, BENCHMARK),
    }
  } catch (error) {
    return {
      def,
      coverage: {
        observations: 0,
        from: null,
        to: null,
        error: error instanceof Error ? error.message : String(error),
      },
      cells: [],
    }
  }
}

export interface RunReport {
  id: string
  series: number
  tests: number
  failed: string[]
  prices_through: string | null
  jumps: string[]
}

export async function runSignals(
  db: PipelineDb,
  deps: {
    ctx: QueryContext
    now: () => Date
    id: string
    /** The site's origin, for each result's source_url. */
    appUrl: string
    defs?: readonly SignalDef[]
  },
): Promise<RunReport> {
  const startedAt = deps.now().toISOString()
  const defs = deps.defs ?? SIGNALS
  const [panel, [through]] = await Promise.all([
    readPanel(db),
    db.select({ newest: max(tables.marketBars.date) }).from(tables.marketBars),
  ])
  const load = createLoader({ db, ctx: deps.ctx })
  const scored: ScoredSeries[] = []
  for (const def of defs) scored.push(await scoreSeries(def, load, panel))

  const runAt = deps.now().toISOString()
  const rows = scored.flatMap(({ def, cells }) =>
    cells.flatMap((cell) =>
      (['in', 'out'] as const).map((sample) => {
        const stat = cell[sample]
        return {
          series_id: def.id,
          ticker: cell.ticker,
          test: def.test,
          horizon: cell.horizon,
          sample,
          status: stat.status,
          n: stat.n,
          estimate: stat.estimate,
          t_stat: stat.t_stat,
          p_value: stat.p_value,
          from_date: stat.from,
          to_date: stat.to,
          source_url: `${deps.appUrl}/signals#${def.id}`,
          fetched_at: runAt,
        }
      }),
    ),
  )
  const tests = rows.filter((r) => r.status === 'ok').length
  const coverage = Object.fromEntries(scored.map((s) => [s.def.id, s.coverage]))
  const failed = scored.filter((s) => s.coverage.error).map((s) => s.def.id)
  // The jumps stay in the task's own result: a day's move is a price, so it
  // never goes into a row a route serves.
  const detail = failed.length ? `couldn’t read ${failed.join(', ')}` : ''

  await runStatements(db, [
    db.delete(tables.signalResults),
    ...chunk(rows, rowsPerStatement(14)).map((group) =>
      db.insert(tables.signalResults).values(group),
    ),
    db.insert(tables.signalRuns).values({
      id: deps.id,
      started_at: startedAt,
      finished_at: runAt,
      status: 'ok',
      series: defs.length,
      tests,
      prices_through: through?.newest ?? null,
      detail: detail || null,
      coverage: JSON.stringify(coverage),
    }),
  ])
  return {
    id: deps.id,
    series: defs.length,
    tests,
    failed,
    prices_through: through?.newest ?? null,
    jumps: panel.jumps,
  }
}

/** The newest run, for the route's cache variant and the page. */
export async function latestRun(db: PipelineDb) {
  const [run] = await db
    .select()
    .from(tables.signalRuns)
    .orderBy(desc(tables.signalRuns.started_at))
    .limit(1)
  return run ?? null
}
