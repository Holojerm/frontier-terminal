// The GPU median rule: when the equal-weight H100 or B200 rental median moves
// 5% or more over seven days, one alert that states both medians, citing one
// `gpu_price` change row that holds each provider's price on both reads. No
// model in the loop: the median is arithmetic on stored recipe observations
// (recipes/gpu-prices.ts, the same rows /api/gpu-prices serves).
//
// The two reads compare like with like. The provider set is held fixed (only
// providers priced on both reads count), and so is each provider's set of
// configurations (only keys it priced both times), so a new Azure region or a
// relabelled SKU moves nothing. A read where any provider's newest run failed
// is skipped whole: the median would shift with no price having moved. Under
// MIN_PROVIDERS in common it is one or two providers' prices, which is the
// single-provider case the judge will weigh (docs/alerts-expansion.md › 4).
//
// Runs after the recipes on every survey tick. The ids hash (gpu, UTC day), so
// a day has one alert per GPU at most, and a move already alerted in the last
// seven days alerts again only when it deepens to critical or turns around.

import { and, eq, gte } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { gpuMedian, gpuState, type GpuObservation } from '../recipes/gpu-series'
import { GPU_MODELS, type GpuModel } from '../recipes/gpu-prices'

export const GPU_MEDIAN_RULE = 'gpu-median-floor' as const

/** How far back the earlier read is, in days. */
export const WINDOW_DAYS = 7
/** A move of this many percent or more is notable; CRITICAL_PCT or more is critical. */
export const NOTABLE_PCT = 5
export const CRITICAL_PCT = 15
/** Providers priced on both reads below which there is no median to speak of. */
export const MIN_PROVIDERS = 3

const DAY_MS = 86_400_000

type Severity = 'notable' | 'critical'

/** The tier of a percent move; null below NOTABLE_PCT. */
export function moveTier(pct: number): Severity | null {
  const size = Math.abs(pct)
  return size >= CRITICAL_PCT ? 'critical' : size >= NOTABLE_PCT ? 'notable' : null
}

export interface ProviderMove {
  provider: string
  before: number
  after: number
  /** Configurations priced on both reads. */
  configurations: number
  before_date: string | null
  after_date: string | null
  source_url: string
  fetched_at: string
}

export interface MedianMove {
  gpu: GpuModel
  before: number
  after: number
  pct: number
  providers: ProviderMove[]
}

const keyOf = (o: GpuObservation) => `${o.provider}\u0000${o.key ?? ''}`

/**
 * The median on both reads over the configurations both priced; null when
 * fewer than MIN_PROVIDERS providers are in common. Pure.
 */
export function medianMove(
  gpu: GpuModel,
  earlier: readonly GpuObservation[],
  later: readonly GpuObservation[],
): MedianMove | null {
  const counted = (xs: readonly GpuObservation[]) =>
    xs.filter((o) => o.gpu === gpu && o.counted && o.key !== undefined)
  const laterKeys = new Set(counted(later).map(keyOf))
  const earlierKeys = new Set(counted(earlier).map(keyOf))
  const before = gpuMedian(
    gpu,
    counted(earlier).filter((o) => laterKeys.has(keyOf(o))),
  )
  const after = gpuMedian(
    gpu,
    counted(later).filter((o) => earlierKeys.has(keyOf(o))),
  )
  const ids = Object.keys(after.providers).sort()
  if (ids.length < MIN_PROVIDERS || before.median === null || after.median === null) return null
  const dateOf = (xs: readonly GpuObservation[], provider: string) =>
    xs.find((o) => o.provider === provider && o.gpu === gpu)?.date ?? null
  return {
    gpu,
    before: before.median,
    after: after.median,
    pct: ((after.median - before.median) / before.median) * 100,
    providers: ids.map((provider) => ({
      provider,
      before: before.providers[provider]!.value,
      after: after.providers[provider]!.value,
      configurations: after.providers[provider]!.rows,
      before_date: dateOf(earlier, provider),
      after_date: dateOf(later, provider),
      source_url: after.providers[provider]!.source_url,
      fetched_at: after.providers[provider]!.fetched_at,
    })),
  }
}

/** One read as change-row JSON: the median, then each provider's price, read date and page. */
function readJson(move: MedianMove, side: 'before' | 'after', date: string) {
  const out: Record<string, string | number | null> = {
    gpu: move.gpu,
    as_of: date,
    median: move[side],
    providers: move.providers.map((p) => p.provider).join(', '),
  }
  for (const p of move.providers) {
    out[`usd.${p.provider}`] = p[side]
    out[`read.${p.provider}`] = side === 'before' ? p.before_date : p.after_date
    out[`source.${p.provider}`] = p.source_url
  }
  if (side === 'after') out.pct_change = Math.round(move.pct * 100) / 100
  return out
}

const perHour = (n: number) => `${money(n)} per GPU-hour`

/** The alert's one line: "H100 rental median falls 6.3% in 7 days, to $4.45 per GPU-hour from $4.75". */
export function headlineFor(move: MedianMove): string {
  const verb = move.after > move.before ? 'rises' : 'falls'
  const size = Math.round(Math.abs(move.pct) * 10) / 10
  return (
    `${move.gpu} rental median ${verb} ${size}% in ${WINDOW_DAYS} days, ` +
    `to ${perHour(move.after)} from ${money(move.before)}`
  )
}

export interface GpuMedianAlert {
  change: ChangeRow
  alert: AlertRow
}

/** The change and alert for one GPU's move; null below NOTABLE_PCT. */
export function gpuMedianAlert(
  move: MedianMove,
  ctx: { now: Date; through: string },
): GpuMedianAlert | null {
  const severity = moveTier(move.pct)
  if (!severity) return null
  const day = ctx.now.toISOString().slice(0, 10)
  const before = readJson(move, 'before', ctx.through)
  const after = readJson(move, 'after', day)
  const newest = move.providers.reduce((a, b) => (b.fetched_at > a.fetched_at ? b : a))
  const detected_at = ctx.now.toISOString()
  const change = ChangeRow.parse({
    id: contentHash({ rule: GPU_MEDIAN_RULE, gpu: move.gpu, day }),
    entity_key: `gpu_price:median:${move.gpu}`,
    entity_type: 'gpu_price',
    provider: 'other',
    change_type: 'modified',
    before_hash: contentHash(before),
    after_hash: contentHash(after),
    before_json: JSON.stringify(before),
    after_json: JSON.stringify(after),
    detected_at,
    source_url: newest.source_url,
    fetched_at: newest.fetched_at,
  })
  const moved = move.providers
    .filter((p) => p.before !== p.after)
    .map(
      (p) =>
        `${gpuProviderName(p.provider)} ${money(p.before)} to ${money(p.after)} (${pctLabel(((p.after - p.before) / p.before) * 100)})`,
    )
  const names = move.providers.map((p) => gpuProviderName(p.provider)).join(', ')
  const configurations = move.providers.reduce((n, p) => n + p.configurations, 0)
  const explanation = [
    `The equal-weight median on-demand ${move.gpu} price was ${perHour(move.before)} on ${ctx.through} and ${perHour(move.after)} on ${day} (${pctLabel(move.pct)}).`,
    `It counts the ${move.providers.length} providers priced on both reads (${names}), each at the median of its own ${move.gpu} configurations.`,
    `Only the ${configurations} configurations a provider listed both times count, so a new region or SKU doesn’t move it.`,
    moved.length ? `Moved: ${moved.join(', ')}.` : '',
    'These are list prices. Reserved and negotiated prices are lower.',
    `Rule-based: a move of ${NOTABLE_PCT}% or more in ${WINDOW_DAYS} days is notable, ${CRITICAL_PCT}% or more is critical. No model in the loop.`,
  ]
    .filter(Boolean)
    .join(' ')
  const alert = AlertRow.parse({
    id: contentHash({ rule: GPU_MEDIAN_RULE, change_id: change.id }),
    severity,
    headline: headlineFor(move),
    explanation,
    change_ids: JSON.stringify([change.id]),
    rule: GPU_MEDIAN_RULE,
    created_at: detected_at,
    source_url: change.source_url,
    fetched_at: change.fetched_at,
  })
  return { change, alert }
}

const RANK: Readonly<Record<Severity, number>> = { notable: 1, critical: 2 }

/**
 * Whether an alert in the last WINDOW_DAYS already said this: the same
 * direction at the same tier or higher. Today's own alert is caught by its id.
 */
function alreadySaid(
  earlier: readonly { after_json: string | null }[],
  move: MedianMove,
  severity: Severity,
): boolean {
  return earlier.some((row) => {
    const pct = (JSON.parse(row.after_json ?? '{}') as { pct_change?: unknown }).pct_change
    if (typeof pct !== 'number') return false
    const tier = moveTier(pct)
    return tier !== null && Math.sign(pct) === Math.sign(move.pct) && RANK[tier] >= RANK[severity]
  })
}

export interface GpuMedianReport {
  /** Why nothing was compared: a failed provider, or nothing stored yet. */
  skipped: string | null
  written: number
  moves: { gpu: GpuModel; before: number; after: number; pct: number; providers: number }[]
}

/** Compare today's GPU prices with those of WINDOW_DAYS ago, and write any new alert. */
export async function writeGpuMedianAlerts(
  db: PipelineDb,
  now = new Date(),
): Promise<GpuMedianReport> {
  const later = await gpuState(db)
  const failed = Object.keys(later.failed).sort()
  if (failed.length) {
    return { skipped: `failed: ${failed.join(', ')}`, written: 0, moves: [] }
  }
  const through = new Date(now.getTime() - WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10)
  const earlier = await gpuState(db, { through })
  if (later.observations.length === 0 || earlier.observations.length === 0) {
    return { skipped: 'no prices stored for one of the two reads', written: 0, moves: [] }
  }
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS).toISOString()
  const report: GpuMedianReport = { skipped: null, written: 0, moves: [] }
  for (const gpu of GPU_MODELS) {
    const move = medianMove(gpu, earlier.observations, later.observations)
    if (!move) continue
    report.moves.push({
      gpu,
      before: move.before,
      after: move.after,
      pct: move.pct,
      providers: move.providers.length,
    })
    const out = gpuMedianAlert(move, { now, through })
    if (!out) continue
    const [stored] = await db
      .select({ id: tables.alerts.id })
      .from(tables.alerts)
      .where(eq(tables.alerts.id, out.alert.id))
    if (stored) continue
    const recent = await db
      .select({ after_json: tables.changes.after_json })
      .from(tables.changes)
      .where(
        and(
          eq(tables.changes.entity_key, out.change.entity_key),
          gte(tables.changes.detected_at, since),
        ),
      )
    if (alreadySaid(recent, move, out.alert.severity as Severity)) continue
    await db.insert(tables.changes).values(out.change).onConflictDoNothing()
    await db.insert(tables.alerts).values(out.alert).onConflictDoNothing()
    report.written += 1
  }
  if (report.written) await emitEvent('alerts.new')
  return report
}
