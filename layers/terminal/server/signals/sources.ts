// One loader per registry source kind: each reads a series out of a table the
// site already fills, or out of the query an existing route serves, and
// returns dated points or events. A new kind of dataset adds a case here and
// to SignalSource in ./registry.ts.

import { and, eq, inArray } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { gridMonths, gridWeeks } from '../../shared/utils/grid-load'
import { PRIMARY_PLACEMENT } from '../pipeline/probes/placement'
import type { PipelineDb } from '../pipeline/store'
import { KCS } from '../prints/ingest'
import type { QueryContext } from '../utils/terminal-db'
import { queryGpuPrices } from '../utils/terminal-gpu'
import { queryGroundTruth } from '../utils/terminal-ground-truth'
import { queryHiringHistory } from '../utils/terminal-hiring'
import { readDownloadSeries, seriesById } from '../theses/download-series'
import { rankingWeeks } from '../utils/terminal-rankings'
import type { EventPoint, Point } from './harness'
import type { SignalSource } from './registry'

export type Loaded = { kind: 'points'; points: Point[] } | { kind: 'events'; events: EventPoint[] }

/** The print reader whose document log dates each Korean release (print_documents.filed is KCS's posting day). */
const KCS_READER = KCS.reader

export interface LoadDeps {
  db: PipelineDb
  ctx: QueryContext
}

/** A recipe key written as a vintage (`anthropic@2026-11-07`): an older read of the same row. */
const VINTAGE = /@\d{4}-\d{2}-\d{2}$/

async function recipePoints(
  db: PipelineDb,
  recipe: string,
  key: string | undefined,
): Promise<Point[]> {
  const rows = await db
    .select({
      key: tables.recipeObservations.key,
      date: tables.recipeObservations.date,
      value: tables.recipeObservations.value,
    })
    .from(tables.recipeObservations)
    .where(
      key === undefined
        ? eq(tables.recipeObservations.recipe_id, recipe)
        : and(
            eq(tables.recipeObservations.recipe_id, recipe),
            eq(tables.recipeObservations.key, key),
          ),
    )
  const current = rows.filter((r) => !VINTAGE.test(r.key))
  const keys = new Set(current.map((r) => r.key))
  if (keys.size > 1) throw new Error(`${recipe} has ${keys.size} keys; the registry must name one`)
  return current
    .filter((r): r is typeof r & { value: number } => r.value !== null && r.value > 0)
    .map((r) => ({ date: r.date.slice(0, 10), value: r.value }))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
}

const memo = <T>(f: () => Promise<T>) => {
  let p: Promise<T> | null = null
  return () => (p ??= f())
}

/**
 * Loaders that share a query: several series read one payload, so each is
 * built once a run. Create one per run.
 */
export function createLoader(deps: LoadDeps) {
  const gpu = memo(() => queryGpuPrices(deps.db, deps.ctx))
  const hiring = memo(() => queryHiringHistory(deps.db, deps.ctx))
  const weeks = memo(() => rankingWeeks(deps.db))
  const downloads = memo(() => readDownloadSeries(deps.db))
  const truth = memo(() => queryGroundTruth(deps.db, deps.ctx))
  const launchAlerts = memo(async () => {
    const alerts = await deps.db
      .select({ created_at: tables.alerts.created_at, change_ids: tables.alerts.change_ids })
      .from(tables.alerts)
      .where(eq(tables.alerts.rule, 'model-floor'))
    const ids = alerts.flatMap((a) => {
      try {
        const parsed = JSON.parse(a.change_ids) as unknown
        return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
      } catch {
        return []
      }
    })
    const providers = new Map<string, string>()
    for (let i = 0; i < ids.length; i += 90) {
      const rows = await deps.db
        .select({ id: tables.changes.id, provider: tables.changes.provider })
        .from(tables.changes)
        .where(inArray(tables.changes.id, ids.slice(i, i + 90)))
      for (const r of rows) providers.set(r.id, r.provider)
    }
    return alerts.map((a) => {
      let first: string | undefined
      try {
        first = (JSON.parse(a.change_ids) as string[])[0]
      } catch {
        first = undefined
      }
      return { date: a.created_at.slice(0, 10), provider: first ? providers.get(first) : undefined }
    })
  })
  const modelChanges = memo(() =>
    deps.db
      .select({
        provider: tables.changes.provider,
        detected_at: tables.changes.detected_at,
        before_json: tables.changes.before_json,
        after_json: tables.changes.after_json,
      })
      .from(tables.changes)
      .where(
        and(eq(tables.changes.entity_type, 'model'), eq(tables.changes.change_type, 'modified')),
      ),
  )

  return async function load(source: SignalSource): Promise<Loaded> {
    switch (source.kind) {
      case 'recipe': {
        return { kind: 'points', points: await recipePoints(deps.db, source.recipe, source.key) }
      }
      case 'download_series': {
        const series = seriesById(await downloads(), source.id)
        if (!series) throw new Error(`no download series ${source.id}`)
        return { kind: 'points', points: series.map((p) => ({ date: p.date, value: p.value })) }
      }
      case 'probe_days': {
        // The pinned placement only: unpinned days left from whichever colo ran
        // the cron, so their times carry a varying distance to the router.
        const rows = await deps.db
          .select({
            day: tables.probeDays.day,
            probes: tables.probeDays.probes,
            rate_limited: tables.probeDays.rate_limited,
            failed: tables.probeDays.failed,
          })
          .from(tables.probeDays)
          .where(
            and(
              eq(tables.probeDays.lab, source.lab),
              eq(tables.probeDays.placement, PRIMARY_PLACEMENT),
            ),
          )
        return {
          kind: 'points',
          points: rows
            .filter((r) => r.probes > 0)
            .map((r) => ({ date: r.day, value: (r.rate_limited + r.failed) / r.probes }))
            .sort((a, b) => (a.date < b.date ? -1 : 1)),
        }
      }
      case 'openrouter_share': {
        const points: Point[] = []
        for (const w of await weeks()) {
          const share = w.share[source.lab]
          if (w.days === 7 && share !== null && share !== undefined) {
            points.push({ date: w.from, value: share })
          }
        }
        return { kind: 'points', points }
      }
      case 'gpu': {
        const { history } = await gpu()
        const series = history.gpus.find((g) => g.gpu === source.gpu)
        const points: Point[] = []
        history.dates.forEach((date, i) => {
          const value =
            source.metric === 'median'
              ? (series?.median[i] ?? null)
              : (() => {
                  const s = series?.spot_combined[i]
                  return s ? (s.low + s.high) / 2 : null
                })()
          if (value !== null) points.push({ date: date.slice(0, 10), value })
        })
        return { kind: 'points', points }
      }
      case 'hiring': {
        const provider = (await hiring()).providers.find((p) => p.provider === source.lab)
        const points = (provider?.dates ?? []).map((date, i) => ({
          date: date.slice(0, 10),
          value: provider!.total[i]!,
        }))
        return { kind: 'points', points: points.filter((p) => p.value > 0) }
      }
      case 'launches':
        return {
          kind: 'events',
          events: (await launchAlerts())
            .filter((a) => a.provider === source.lab)
            .map((a) => ({ date: a.date, value: 1 })),
        }
      case 'price_changes': {
        const events: EventPoint[] = []
        for (const c of await modelChanges()) {
          if (c.provider !== source.lab) continue
          const before = inputPrice(c.before_json)
          const after = inputPrice(c.after_json)
          if (before === null || after === null || before === after) continue
          if (after < before === (source.direction === 'cut')) {
            events.push({ date: c.detected_at.slice(0, 10), value: 1 })
          }
        }
        return { kind: 'events', events }
      }
      case 'grid_load': {
        const days = await deps.db
          .select({
            date: tables.gridLoadDays.date,
            mwh: tables.gridLoadDays.mwh,
            hours: tables.gridLoadDays.hours,
          })
          .from(tables.gridLoadDays)
          .where(eq(tables.gridLoadDays.ba, source.ba))
          .orderBy(tables.gridLoadDays.date)
        const points =
          source.period === 'month'
            ? gridMonths(days).map((m) => ({ date: `${m.month}-01`, value: m.yoy }))
            : gridWeeks(days).map((w) => ({ date: w.week, value: w.yoy }))
        return {
          kind: 'points',
          points: points.filter((p): p is Point => p.value !== null),
        }
      }
      case 'ercot_large_loads': {
        // The first report to state a month: what was public then. A later
        // report's restatement would be a value nobody had at the time.
        const rows = await deps.db
          .select({
            period: tables.ercotLargeLoadFacts.period,
            value: tables.ercotLargeLoadFacts.value,
            posted: tables.ercotLargeLoadFacts.posted,
          })
          .from(tables.ercotLargeLoadFacts)
          .where(eq(tables.ercotLargeLoadFacts.metric, source.metric))
        const first = new Map<string, { value: number; posted: string }>()
        for (const r of rows) {
          const f = first.get(r.period)
          if (!f || r.posted < f.posted) first.set(r.period, r)
        }
        return {
          kind: 'points',
          points: [...first.entries()]
            .map(([period, f]) => ({ date: `${period}-01`, value: f.value }))
            .sort((a, b) => (a.date < b.date ? -1 : 1)),
        }
      }
      case 'prints': {
        // Each month (or 10- or 20-day count) as the first release to state a
        // year-on-year change put it: the earliest print row with one, from
        // whichever source (a provisional Korean month can state the value
        // alone, its confirmed release the change). It is dated public on
        // the release's own time where it states one, else on the day KCS
        // posted it (print_documents.filed), else available_after_days after
        // the period. Every source is read, the held ones included
        // (PRINT_HELD_SOURCES): the harness publishes statistics, never rows.
        const t = tables.hardwarePrints
        const d = tables.printDocuments
        const rows = await deps.db
          .select({
            period: t.period,
            yoy: t.yoy_pct,
            published_at: t.published_at,
            posted: d.filed,
          })
          .from(t)
          .leftJoin(d, and(eq(d.raw_key, t.raw_key), eq(d.source_id, KCS_READER)))
          .where(
            and(
              eq(t.series, source.series),
              eq(t.entity, source.entity),
              eq(t.window, source.window ?? 'month'),
              eq(t.observed_as, 'print'),
            ),
          )
          .orderBy(t.first_seen_at, t.vintage)
        const byMonth = new Map<string, Point>()
        for (const r of rows) {
          if (r.yoy === null || byMonth.has(r.period)) continue
          const date = `${r.period}-01`
          const available = r.published_at?.slice(0, 10) ?? r.posted
          byMonth.set(
            r.period,
            available ? { date, value: r.yoy, available } : { date, value: r.yoy },
          )
        }
        return {
          kind: 'points',
          points: [...byMonth.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
        }
      }
      case 'revenue_vs_reported':
        return {
          kind: 'events',
          // Positive when the filing came in above what the press reported.
          events: (await truth()).resolutions
            .filter((r) => r.lab === source.lab)
            .map((r) => ({ date: r.filed.first_filed.slice(0, 10), value: -r.error_pct })),
        }
    }
  }
}

function inputPrice(json: string | null): number | null {
  if (!json) return null
  try {
    const v = (JSON.parse(json) as { input_per_mtok?: unknown }).input_per_mtok
    return typeof v === 'number' && v > 0 ? v : null
  } catch {
    return null
  }
}
