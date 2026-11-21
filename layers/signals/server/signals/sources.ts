// One loader per registry source kind: each reads a series out of a table the
// site already fills, or out of the query an existing route serves, and
// returns dated points or events. A new kind of dataset adds a case here and
// to SignalSource in ./registry.ts.

import { and, eq, inArray } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { ARCHIVE_UNTIL } from '#layers/pricing/server/pipeline/archive/eras'
import { LIMITS_LIVE_FROM } from '#layers/pricing/server/pipeline/archive/limits-eras'
import type { ArchivedPriceEvent } from '#layers/pricing/server/pipeline/archive/price-events'
import { PRIMARY_PLACEMENT } from '../../../reliability/server/pipeline/probes/placement'
import { KCS } from '#layers/compute/server/prints/ingest'
import { shiftPeriod } from '#layers/compute/server/prints/parse'
import { readDownloadSeries, seriesById } from '#layers/adoption/server/recipes/download-series'
import type { EventPoint, Point } from './harness'
import type { SignalSource } from './registry'

export type Loaded = { kind: 'points'; points: Point[] } | { kind: 'events'; events: EventPoint[] }

/** The print reader whose document log dates each Korean release (print_documents.filed is KCS's posting day). */
const KCS_READER = KCS.reader

export interface LoadDeps {
  db: PipelineDb
  ctx: QueryContext
}

/** The first day the live loaders count: the archived price lists end here. */
const LIVE_FROM = ARCHIVE_UNTIL.slice(0, 10)

const archivedEvent = (e: ArchivedPriceEvent): EventPoint =>
  e.window_days > 0
    ? { date: e.date, value: 1, window_days: e.window_days }
    : { date: e.date, value: 1 }

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
  const archived = memo(() => archivedPriceEvents(deps.db))
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
          events: [
            ...(await archived())
              .filter((e) => e.kind === 'launch' && e.provider === source.lab)
              .map(archivedEvent),
            ...(await launchAlerts())
              .filter((a) => a.provider === source.lab && a.date >= LIVE_FROM)
              .map((a) => ({ date: a.date, value: 1 })),
          ],
        }
      case 'price_changes': {
        const kind = source.direction === 'cut' ? 'price_cut' : 'price_raise'
        const events: EventPoint[] = (await archived())
          .filter((e) => e.kind === kind && e.provider === source.lab)
          .map(archivedEvent)
        for (const c of await modelChanges()) {
          if (c.provider !== source.lab || c.detected_at.slice(0, 10) < LIVE_FROM) continue
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
      case 'listed_hiring': {
        // One point per successful read, as counted then; the harness keeps
        // each week's last. A failed read has no count and is no point.
        const rows = await deps.db
          .select({
            read_at: tables.listedHiringReads.read_at,
            total: tables.listedHiringReads.total,
            datacenter: tables.listedHiringReads.datacenter,
          })
          .from(tables.listedHiringReads)
          .where(
            and(
              eq(tables.listedHiringReads.board_id, source.board),
              eq(tables.listedHiringReads.status, 'read'),
            ),
          )
          .orderBy(tables.listedHiringReads.read_at)
        const points: Point[] = []
        for (const r of rows) {
          const value = source.metric === 'total' ? r.total : r.datacenter
          if (value !== null) points.push({ date: r.read_at.slice(0, 10), value })
        }
        return { kind: 'points', points }
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
        if (source.yoy === 'derived')
          return { kind: 'points', points: await derivedYoy(deps.db, source) }
        // Each month (or 10- or 20-day count) as the first release to state a year-on-year
        // change put it: the earliest print row with one, from any source (a provisional
        // Korean month can state the value alone, its confirmed release the change). Dated
        // public at the release's own time where it states one, else the day KCS posted it
        // (print_documents.filed), else available_after_days after the period. Held sources
        // (PRINT_HELD_SOURCES) are read too: the harness publishes statistics, never rows.
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
      case 'guidance_surprise': {
        const rows = await deps.db
          .select({
            filed: tables.guidanceResolutions.filed,
            error_share: tables.guidanceResolutions.error_share,
          })
          .from(tables.guidanceResolutions)
          .where(
            and(
              eq(tables.guidanceResolutions.ticker, source.ticker),
              source.metric ? eq(tables.guidanceResolutions.metric, source.metric) : undefined,
            ),
          )
        // One event per filing: the mean error of what it settled.
        const byDay = new Map<string, number[]>()
        for (const r of rows) byDay.set(r.filed, [...(byDay.get(r.filed) ?? []), r.error_share])
        return {
          kind: 'events',
          events: [...byDay]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, errors]) => ({
              date,
              value: errors.reduce((s, e) => s + e, 0) / errors.length,
            })),
        }
      }
      case 'limit_raises': {
        // Archived copies to the live start, then the live recipe's
        // snapshots: each limit or cap raised between two readings. The live
        // recipe runs daily, so a change is dated to within a day.
        const archived = (await archivedLimitChanges(deps.db)).filter(
          (c) =>
            c.recipe_id === source.recipe &&
            c.after > c.before &&
            c.date < LIMITS_LIVE_FROM.slice(0, 10),
        )
        const live = await deps.db
          .select({
            key: tables.recipeObservations.key,
            date: tables.recipeObservations.date,
            value: tables.recipeObservations.value,
          })
          .from(tables.recipeObservations)
          .where(eq(tables.recipeObservations.recipe_id, source.recipe))
        const byKey = new Map<string, { date: string; value: number | null }[]>()
        for (const r of live) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r])
        const events: EventPoint[] = archived.map((c) =>
          c.window_days > 0
            ? { date: c.date, value: 1, window_days: c.window_days }
            : { date: c.date, value: 1 },
        )
        for (const list of byKey.values()) {
          list.sort((a, b) => (a.date < b.date ? -1 : 1))
          for (let i = 1; i < list.length; i++) {
            const [a, b] = [list[i - 1]!.value, list[i]!.value]
            if (a !== null && b !== null && b > a)
              events.push({ date: list[i]!.date, value: 1, window_days: 1 })
          }
        }
        return { kind: 'events', events }
      }
      case 'filed_quarters': {
        // Each quarter as the first filing that stated it: what was public
        // then. A later filing's comparative is a restatement nobody had.
        const facts = await deps.db
          .select({
            dims: tables.filedFacts.dims,
            start: tables.filedFacts.start,
            end: tables.filedFacts.end,
            value: tables.filedFacts.value,
            filed: tables.filedFacts.filed,
          })
          .from(tables.filedFacts)
          .where(
            and(
              eq(tables.filedFacts.ticker, source.ticker),
              eq(tables.filedFacts.concept, source.concept),
            ),
          )
        const text = source.text_metric
          ? await deps.db
              .select({
                start: tables.filedTextFacts.start,
                end: tables.filedTextFacts.end,
                value: tables.filedTextFacts.value,
                filed: tables.filedTextFacts.filed,
              })
              .from(tables.filedTextFacts)
              .where(
                and(
                  eq(tables.filedTextFacts.ticker, source.ticker),
                  eq(tables.filedTextFacts.metric, source.text_metric),
                ),
              )
          : []
        const onMember = facts.filter((f) =>
          f.dims.split(';').every((d) => d.endsWith(`=${source.member}`)),
        )
        return { kind: 'points', points: firstFiledQuarters([...onMember, ...text]) }
      }
      case 'quarterly_growth': {
        const rows = await deps.db
          .select({
            date: tables.recipeObservations.date,
            value: tables.recipeObservations.value,
            payload: tables.recipeObservations.payload,
          })
          .from(tables.recipeObservations)
          .where(
            and(
              eq(tables.recipeObservations.recipe_id, source.recipe),
              eq(tables.recipeObservations.key, source.key),
            ),
          )
        return { kind: 'points', points: quarterlyGrowth(rows, source.lag_days) }
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

/**
 * The year-on-year change of a print series that states none, point in time.
 * Each month is its first vintage, public at its release time (published_at,
 * else first_seen_at); its base is the vintage of the month a year earlier
 * that was public by then, else that month's first, and the change is public
 * at the later of the two. The harness never sees a base revised after the
 * month was public.
 */
async function derivedYoy(
  db: PipelineDb,
  source: Extract<SignalSource, { kind: 'prints' }>,
): Promise<Point[]> {
  const t = tables.hardwarePrints
  const rows = await db
    .select({
      period: t.period,
      value: t.value,
      vintage: t.vintage,
      published_at: t.published_at,
      first_seen_at: t.first_seen_at,
    })
    .from(t)
    .where(
      and(
        eq(t.series, source.series),
        eq(t.entity, source.entity),
        eq(t.window, source.window ?? 'month'),
        eq(t.observed_as, 'print'),
      ),
    )
  const byMonth = new Map<string, { value: number; at: string }[]>()
  for (const r of rows) {
    const at = r.published_at ?? r.first_seen_at
    byMonth.set(r.period, [...(byMonth.get(r.period) ?? []), { value: r.value, at }])
  }
  for (const v of byMonth.values()) v.sort((a, b) => a.at.localeCompare(b.at))
  const points: Point[] = []
  for (const [period, vintages] of byMonth) {
    const base = byMonth.get(shiftPeriod(period, -12))
    if (!base) continue
    const first = vintages[0]!
    const b = base.findLast((v) => v.at <= first.at) ?? base[0]!
    if (!(b.value > 0)) continue
    points.push({
      date: `${period}-01`,
      value: (first.value / b.value - 1) * 100,
      available: (b.at > first.at ? b.at : first.at).slice(0, 10),
    })
  }
  return points.sort((a, b) => (a.date < b.date ? -1 : 1))
}

const QUARTER_DAYS = { min: 80, max: 100 }

const daysBetween = (start: string, end: string) =>
  Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1

/** Each 3-month period's first-filed value, dated by its month and public on its filing date. */
export function firstFiledQuarters(
  rows: readonly { start: string | null; end: string; value: number; filed: string }[],
): Point[] {
  const first = new Map<string, { value: number; filed: string }>()
  for (const r of rows) {
    if (!r.start) continue
    const d = daysBetween(r.start, r.end)
    if (d < QUARTER_DAYS.min || d > QUARTER_DAYS.max) continue
    const f = first.get(r.end)
    if (!f || r.filed < f.filed) first.set(r.end, { value: r.value, filed: r.filed })
  }
  return [...first.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([end, f]) => ({ date: `${end.slice(0, 7)}-01`, value: f.value, available: f.filed }))
}

/**
 * The log change of a quarterly figure on the quarter before, dated by the
 * quarter's last month: public on payload.released where the row has it,
 * else lagDays after the quarter's end. A quarter with no figure breaks the
 * chain.
 */
export function quarterlyGrowth(
  rows: readonly { date: string; value: number | null; payload: string }[],
  lagDays: number,
): Point[] {
  const sorted = rows
    .filter((r): r is typeof r & { value: number } => r.value !== null && r.value > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
  const out: Point[] = []
  for (let i = 1; i < sorted.length; i++) {
    const [prev, cur] = [sorted[i - 1]!, sorted[i]!]
    const gap = daysBetween(prev.date, cur.date) - 1
    if (gap < QUARTER_DAYS.min || gap > QUARTER_DAYS.max) continue
    let released: string | null = null
    try {
      const v = (JSON.parse(cur.payload) as { released?: unknown }).released
      released = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null
    } catch {
      released = null
    }
    const available =
      released ??
      new Date(Date.parse(`${cur.date}T00:00:00Z`) + lagDays * 86_400_000)
        .toISOString()
        .slice(0, 10)
    out.push({
      date: `${cur.date.slice(0, 7)}-01`,
      value: Math.log(cur.value / prev.value),
      available,
    })
  }
  return out
}
