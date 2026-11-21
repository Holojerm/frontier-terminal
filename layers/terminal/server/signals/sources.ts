// One loader per registry source kind: each reads a series out of a table the
// site already fills, or out of the query an existing route serves, and
// returns dated points or events. A new kind of dataset adds a case here and
// to SignalSource in ./registry.ts.

import { and, eq, inArray } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type { PipelineDb } from '../pipeline/store'
import type { QueryContext } from '../utils/terminal-db'
import { queryGpuPrices } from '../utils/terminal-gpu'
import { queryGroundTruth } from '../utils/terminal-ground-truth'
import { queryHiringHistory } from '../utils/terminal-hiring'
import { readDownloadSeries, seriesById } from '../theses/download-series'
import { rankingWeeks } from '../utils/terminal-rankings'
import type { EventPoint, Point } from './harness'
import type { SignalSource } from './registry'

export type Loaded = { kind: 'points'; points: Point[] } | { kind: 'events'; events: EventPoint[] }

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
        const rows = await deps.db
          .select({
            day: tables.probeDays.day,
            placement: tables.probeDays.placement,
            probes: tables.probeDays.probes,
            rate_limited: tables.probeDays.rate_limited,
            failed: tables.probeDays.failed,
          })
          .from(tables.probeDays)
          .where(eq(tables.probeDays.lab, source.lab))
        // One reading a day: the pinned placement's where the changeover day has both.
        const byDay = new Map<string, (typeof rows)[number]>()
        for (const r of rows) {
          if (r.probes === 0) continue
          const held = byDay.get(r.day)
          if (!held || held.placement === 'unpinned') byDay.set(r.day, r)
        }
        return {
          kind: 'points',
          points: [...byDay.values()]
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
