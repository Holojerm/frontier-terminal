// The demand-share axis: OpenRouter's daily usage rankings, folded into a
// 7-day token share per lab (and its change against the 7 days before), each
// lab's top models in that window, and a 30-day daily series. Read-only over
// the `entities` table like the rest of terminal-db.ts; split out because the
// arithmetic is its own thing and test/terminal-rankings.test.ts drives the
// pure half without a database.
//
// Windows are counted in DAYS PRESENT, newest first, not calendar days from
// the reader's clock: a feed that lags two days still reports its newest
// seven, and the dates the share rests on ship with the number.

import { and, desc, eq, like, max, sql } from 'drizzle-orm'

import type {
  BigFour,
  DateWindow,
  Prov,
  ProviderId,
  ProviderShare,
  ProviderTopModels,
  RankingDay,
  RankingsCoverage,
  RankingsData,
} from '#shared/utils/terminal-types'

import * as tables from '../db/schema'
import { asOfFromDetail } from '../pipeline/lanes'
import { manifestFixtures } from '../pipeline/parsers/fixture-provenance'
import type { PipelineDb } from '../pipeline/store'
import { lastRuns, sourceStamps, type QueryContext } from './terminal-db'
import { PROVIDER_DISPLAY, PROVIDER_ORDER, labelOf } from './terminal-sources'

export const RANKINGS_SOURCE_ID = 'openrouter-rankings-daily'
export const SHARE_WINDOW_DAYS = 7
export const SERIES_DAYS = 30
export const TOP_MODELS = 5

const PROVIDERS: readonly ProviderId[] = [...PROVIDER_ORDER, 'other']

export interface RankingObservation extends Prov {
  date: string
  provider: ProviderId
  model_permaslug: string
  total_tokens: number
}

export interface RankingsSummary {
  coverage: RankingsCoverage
  shares: ProviderShare[]
  top_models: ProviderTopModels[]
  series: RankingDay[]
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const emptyTokens = (): Record<ProviderId, number> => ({
  openai: 0,
  anthropic: 0,
  google: 0,
  xai: 0,
  other: 0,
})

const windowOf = (dates: readonly string[]): DateWindow | null =>
  dates.length ? { from: dates[0]!, to: dates.at(-1)! } : null

/** Pure: every number the panel shows, from the stored observations alone. */
export function summarizeRankings(rows: readonly RankingObservation[]): RankingsSummary {
  const dates = [...new Set(rows.map((r) => r.date))].sort(byString)
  const windowDates = dates.slice(-SHARE_WINDOW_DAYS)
  const priorDates = dates.slice(-2 * SHARE_WINDOW_DAYS, -SHARE_WINDOW_DAYS)
  const inWindow = new Set(windowDates)
  const inPrior = new Set(priorDates)

  const windowTokens = emptyTokens()
  const priorTokens = emptyTokens()
  for (const r of rows) {
    if (inWindow.has(r.date)) windowTokens[r.provider] += r.total_tokens
    else if (inPrior.has(r.date)) priorTokens[r.provider] += r.total_tokens
  }
  const windowTotal = PROVIDERS.reduce((acc, p) => acc + windowTokens[p], 0)
  const priorTotal = PROVIDERS.reduce((acc, p) => acc + priorTokens[p], 0)
  const shareOf = (tokens: number, total: number) => (total > 0 ? tokens / total : null)

  const shares: ProviderShare[] = PROVIDERS.map((provider) => {
    const share = shareOf(windowTokens[provider], windowTotal)
    // No prior window at all (fewer than 8 days) is "no comparison", not a
    // change from zero.
    const prior_share = priorDates.length ? shareOf(priorTokens[provider], priorTotal) : null
    return {
      provider,
      display: PROVIDER_DISPLAY[provider],
      tokens: windowTokens[provider],
      share,
      prior_tokens: priorTokens[provider],
      prior_share,
      delta_pp: share !== null && prior_share !== null ? (share - prior_share) * 100 : null,
    }
  })

  // The aggregated `other` row has no vendor prefix and is not a model.
  const isModel = (slug: string) => slug.includes('/')
  const top_models: ProviderTopModels[] = PROVIDER_ORDER.map((provider) => {
    const byModel = new Map<string, { tokens: number; newest: RankingObservation }>()
    for (const r of rows) {
      if (r.provider !== provider || !inWindow.has(r.date) || !isModel(r.model_permaslug)) continue
      const cur = byModel.get(r.model_permaslug)
      if (!cur) byModel.set(r.model_permaslug, { tokens: r.total_tokens, newest: r })
      else {
        cur.tokens += r.total_tokens
        if (r.fetched_at > cur.newest.fetched_at) cur.newest = r
      }
    }
    const models = [...byModel.entries()]
      .sort(([slugA, a], [slugB, b]) => b.tokens - a.tokens || byString(slugA, slugB))
      .slice(0, TOP_MODELS)
      .map(([model_permaslug, { tokens, newest }]) => ({
        provider,
        model_permaslug,
        tokens,
        share_of_provider: shareOf(tokens, windowTokens[provider]),
        source_url: newest.source_url,
        fetched_at: newest.fetched_at,
      }))
    return { provider: provider as BigFour, display: PROVIDER_DISPLAY[provider], models }
  })

  const seriesDates = dates.slice(-SERIES_DAYS)
  const perDay = new Map<string, RankingDay>(
    seriesDates.map((date) => [date, { date, tokens: emptyTokens(), total: 0 }]),
  )
  for (const r of rows) {
    const day = perDay.get(r.date)
    if (!day) continue
    day.tokens[r.provider] += r.total_tokens
    day.total += r.total_tokens
  }

  return {
    coverage: {
      days: dates.length,
      first_date: dates[0] ?? null,
      last_date: dates.at(-1) ?? null,
      window: windowOf(windowDates),
      prior_window: windowOf(priorDates),
    },
    shares,
    top_models,
    series: seriesDates.map((d) => perDay.get(d)!),
  }
}

/** ISO date `days` days before `date` (UTC arithmetic on the calendar, no clock). */
export function daysBefore(date: string, days: number): string {
  const t = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)) - days,
  )
  return new Date(t).toISOString().slice(0, 10)
}

const isRanking = eq(tables.entities.entity_type, 'ranking')
const dateOf = sql<string | null>`json_extract(${tables.entities.payload}, '$.date')`

/** Observations for the newest SERIES_DAYS days — the table grows by ~50 rows
 * a day forever, so the read is bounded by date, never the whole type. */
export async function rankingObservations(db: PipelineDb): Promise<RankingObservation[]> {
  const [bounds] = await db
    .select({ newest: max(dateOf) })
    .from(tables.entities)
    .where(isRanking)
  const newest = bounds?.newest ?? null
  if (!newest) return []
  const cutoff = daysBefore(newest, SERIES_DAYS - 1)

  const rows = await db
    .select({
      provider: tables.entities.provider,
      payload: tables.entities.payload,
      source_url: tables.entities.source_url,
      fetched_at: tables.entities.fetched_at,
    })
    .from(tables.entities)
    .where(and(isRanking, sql`${dateOf} >= ${cutoff}`))

  const out: RankingObservation[] = []
  for (const row of rows) {
    let payload: unknown
    try {
      payload = JSON.parse(row.payload)
    } catch {
      continue
    }
    if (typeof payload !== 'object' || payload === null) continue
    const p = payload as Record<string, unknown>
    if (
      typeof p.date !== 'string' ||
      typeof p.model_permaslug !== 'string' ||
      typeof p.total_tokens !== 'number'
    ) {
      continue
    }
    out.push({
      date: p.date,
      provider: row.provider as ProviderId,
      model_permaslug: p.model_permaslug,
      total_tokens: p.total_tokens,
      source_url: row.source_url,
      fetched_at: row.fetched_at,
    })
  }
  return out
}

/** meta.as_of from the newest run whose detail carries one (lanes.ts). */
async function newestAsOf(db: PipelineDb): Promise<string | null> {
  const [row] = await db
    .select({ detail: tables.sourceRuns.detail })
    .from(tables.sourceRuns)
    .where(
      and(
        eq(tables.sourceRuns.source_id, RANKINGS_SOURCE_ID),
        like(tables.sourceRuns.detail, '%as_of %'),
      ),
    )
    .orderBy(desc(tables.sourceRuns.started_at))
    .limit(1)
  return asOfFromDetail(row?.detail ?? null)
}

export async function queryRankings(db: PipelineDb, ctx: QueryContext): Promise<RankingsData> {
  const [rows, stamps, runs, as_of] = await Promise.all([
    rankingObservations(db),
    sourceStamps(db),
    lastRuns(db),
    newestAsOf(db),
  ])
  const summary = summarizeRankings(rows)
  const registered = ctx.registry.sources.find((s) => s.source_id === RANKINGS_SOURCE_ID)
  const stamp = stamps.get(RANKINGS_SOURCE_ID) ?? null
  const last_run = runs.get(RANKINGS_SOURCE_ID) ?? null

  const status: RankingsData['status'] =
    rows.length > 0 ? 'ok' : last_run?.status === 'skipped' ? 'not_configured' : 'no_rows'

  // The citation template is the source's own words (sources.yaml); only the
  // as_of placeholder is filled, from OpenRouter's meta, never from our clock.
  const citation =
    registered?.citation?.replace('{meta.as_of}', as_of ?? '(as_of not yet recorded)') ?? null

  return {
    as_of: ctx.as_of,
    computed_at: ctx.now().toISOString(),
    status,
    source: {
      source_id: RANKINGS_SOURCE_ID,
      label: labelOf(RANKINGS_SOURCE_ID).label,
      url:
        manifestFixtures.find((f) => f.source_id === RANKINGS_SOURCE_ID)?.source_url ??
        registered?.url ??
        '',
      caveat: registered?.caveat ?? null,
      license: registered?.license ?? null,
      last_run,
      newest_snapshot: stamp?.newest ?? null,
    },
    provenance: stamp
      ? { source_url: stamp.newest.source_url, fetched_at: stamp.newest.fetched_at }
      : null,
    meta: { as_of, citation, coverage: summary.coverage },
    shares: summary.shares,
    top_models: summary.top_models,
    series: summary.series,
  }
}
