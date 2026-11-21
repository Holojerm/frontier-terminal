// The statistics: pure functions of a series and a price panel, so tests drive them with
// made-up numbers.
//
// Lead-lag. A series is folded into its period (week or month) and turned into one change
// a period (log change for a level or a normalized level, a difference for a share, as
// given for a change). Each change is dated at the first session after it became public
// (registry › available_after_days). Its forward return over h sessions is the ticker's
// return less the benchmark's; the statistic is the Pearson correlation of the two.
//
// Event study. Each event day's abnormal return runs from the close of the last session
// before the event to h sessions later (h = 1 is the event day's own move). The statistic
// is the mean, signed by the event's value where the registry says so. An event dated only
// to the gap between two copies of a page counts at a horizon only when the gap is narrow
// enough (maxWindowDays).
//
// Both hold out the newest third of observations by date, so the out-of-sample number is
// one nobody could have fitted. Returns over h sessions from observations fewer than h
// sessions apart overlap, so each p-value's sample is shrunk to n × spacing / h.

import { addDays, type PricePanel } from './market'

export interface Point {
  date: string
  value: number
  /**
   * The day the value became public, where the source states it (a release
   * time). Without it the change is public available_after_days after its
   * period ends. A 10-day count is public before its month ends.
   */
  available?: string
}

export type Period = 'day' | 'week' | 'month'

// ── periods ─────────────────────────────────────────────────────────────────

const ms = (date: string) => Date.parse(`${date}T00:00:00Z`)

/** The period a date falls in, named by its first day (a week starts Monday). */
export function periodKey(date: string, period: Period): string {
  if (period === 'day') return date
  if (period === 'month') return `${date.slice(0, 7)}-01`
  const dow = new Date(ms(date)).getUTCDay()
  return addDays(date, -((dow + 6) % 7))
}

export function nextPeriod(key: string, period: Period): string {
  if (period === 'day') return addDays(key, 1)
  if (period === 'week') return addDays(key, 7)
  const [y, m] = key.split('-').map(Number) as [number, number]
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
}

export const periodEnd = (key: string, period: Period) =>
  period === 'day' ? key : addDays(nextPeriod(key, period), -1)

const daysIn = (key: string, period: Period) =>
  Math.round((ms(nextPeriod(key, period)) - ms(key)) / 86_400_000)

/**
 * Daily points folded into periods. `sum` keeps only periods with every day
 * present, since a partial week of downloads reads as a drop. `mean` needs
 * over half the period's days. `last` keeps the period's newest value.
 */
export function resample(
  points: readonly Point[],
  period: Period,
  aggregate: 'sum' | 'mean' | 'last',
): Point[] {
  const groups = new Map<string, Point[]>()
  for (const p of points) {
    const key = periodKey(p.date, period)
    const list = groups.get(key) ?? []
    list.push(p)
    groups.set(key, list)
  }
  const out: Point[] = []
  for (const [key, list] of groups) {
    const days = new Set(list.map((p) => p.date)).size
    const total = list.reduce((s, p) => s + p.value, 0)
    if (aggregate === 'sum') {
      if (days >= daysIn(key, period)) out.push({ date: key, value: total })
    } else if (aggregate === 'mean') {
      if (days * 2 > daysIn(key, period)) out.push({ date: key, value: total / list.length })
    } else {
      const newest = list.reduce((a, b) => (b.date > a.date ? b : a))
      out.push(
        newest.available
          ? { date: key, value: newest.value, available: newest.available }
          : { date: key, value: newest.value },
      )
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1))
}

export interface Change {
  /** The period the change ends in. */
  period: string
  /** The day it became public. */
  available: string
  x: number
}

/** One change per pair of consecutive periods; a gap breaks the chain. */
export function changesOf(
  points: readonly Point[],
  transform: SignalTransform,
  period: Period,
  lagDays: number,
): Change[] {
  const out: Change[] = []
  for (let i = 0; i < points.length; i++) {
    const cur = points[i]!
    let x: number | null = null
    if (transform === 'change') {
      x = cur.value
    } else {
      const prev = points[i - 1]
      if (!prev || nextPeriod(prev.date, period) !== cur.date) continue
      if (transform === 'share') x = cur.value - prev.value
      else if (prev.value > 0 && cur.value > 0) x = Math.log(cur.value / prev.value)
    }
    if (x === null || !Number.isFinite(x)) continue
    out.push({
      period: cur.date,
      available: cur.available ?? addDays(periodEnd(cur.date, period), lagDays),
      x,
    })
  }
  return out
}

// ── returns ─────────────────────────────────────────────────────────────────

/** Index of the first session strictly after `date`. */
export function sessionAfter(dates: readonly string[], date: string): number {
  let lo = 0
  let hi = dates.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (dates[mid]! <= date) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Index of the last session strictly before `date`, or -1. */
export function sessionBefore(dates: readonly string[], date: string): number {
  let lo = 0
  let hi = dates.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (dates[mid]! < date) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}

/** The ticker's return from session i to i + h, less the benchmark's. Null where a close is missing. */
export function abnormalReturn(
  panel: PricePanel,
  ticker: string,
  benchmark: string,
  i: number,
  h: number,
): number | null {
  const p = panel.close.get(ticker)
  const b = panel.close.get(benchmark)
  if (!p || !b || i < 0 || i + h >= panel.dates.length) return null
  const p0 = p[i]
  const p1 = p[i + h]
  const b0 = b[i]
  const b1 = b[i + h]
  if (!p0 || !p1 || !b0 || !b1) return null
  return p1 / p0 - b1 / b0
}

// ── statistics ──────────────────────────────────────────────────────────────

export function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length
  if (n < 3 || ys.length !== n) return null
  const mx = xs.reduce((s, v) => s + v, 0) / n
  const my = ys.reduce((s, v) => s + v, 0) / n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx
    const dy = ys[i]! - my
    sxy += dx * dy
    sxx += dx * dx
    syy += dy * dy
  }
  if (sxx === 0 || syy === 0) return null
  return sxy / Math.sqrt(sxx * syy)
}

function lnGamma(x: number): number {
  const c = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5,
  ]
  let y = x
  const t = x + 5.5 - (x + 0.5) * Math.log(x + 5.5)
  let s = 1.000000000190015
  for (const ci of c) s += ci / ++y
  return -t + Math.log((2.5066282746310005 * s) / x)
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const tiny = 1e-30
  let c = 1
  let d = 1 - ((a + b) * x) / (a + 1)
  if (Math.abs(d) < tiny) d = tiny
  d = 1 / d
  let h = d
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < tiny) d = tiny
    c = 1 + aa / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1))
    d = 1 + aa * d
    if (Math.abs(d) < tiny) d = tiny
    c = 1 + aa / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const delta = d * c
    h *= delta
    if (Math.abs(delta - 1) < 3e-12) break
  }
  return h
}

/** The regularized incomplete beta function I_x(a, b). */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const front = Math.exp(
    lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  )
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(a, b, x)) / a
    : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b
}

/** Two-sided p-value of a t statistic with `df` degrees of freedom. */
export function twoSidedP(t: number, df: number): number | null {
  if (!Number.isFinite(t) || df <= 0) return null
  return incompleteBeta(df / (df + t * t), df / 2, 0.5)
}

/** The sample left once returns over h sessions overlap: n × spacing / h, never above n. */
export function effectiveN(n: number, spacing: number, h: number): number {
  return Math.max(0, Math.min(n, Math.floor((n * Math.max(spacing, 1)) / h)))
}

function median(values: readonly number[]): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

/** Median sessions between consecutive entries. */
export function spacingOf(entries: readonly number[]): number {
  const gaps: number[] = []
  for (let i = 1; i < entries.length; i++) gaps.push(entries[i]! - entries[i - 1]!)
  return median(gaps)
}

/** Fewest independent returns a test runs on, once overlap is taken out. */
export const MIN_EFFECTIVE = 3

const thin = (n: number): SignalStat => ({
  status: 'thin',
  n,
  estimate: null,
  t_stat: null,
  p_value: null,
})

export function correlationStat(
  pairs: readonly { entry: number; x: number; y: number }[],
  h: number,
  min: number,
): SignalStat {
  const n = pairs.length
  if (n < min) return thin(n)
  const r = pearson(
    pairs.map((p) => p.x),
    pairs.map((p) => p.y),
  )
  if (r === null) return thin(n)
  const nEff = effectiveN(n, spacingOf(pairs.map((p) => p.entry)), h)
  const df = nEff - 2
  if (nEff < MIN_EFFECTIVE || Math.abs(r) >= 1) return thin(n)
  const t = r * Math.sqrt(df / (1 - r * r))
  return {
    status: 'ok',
    n,
    estimate: r,
    t_stat: t,
    p_value: twoSidedP(t, df),
  }
}

export function meanStat(
  rows: readonly { entry: number; car: number }[],
  h: number,
  min: number,
): SignalStat {
  const n = rows.length
  if (n < min) return thin(n)
  const mean = rows.reduce((s, r) => s + r.car, 0) / n
  const variance = rows.reduce((s, r) => s + (r.car - mean) ** 2, 0) / (n - 1)
  const nEff = effectiveN(n, spacingOf(rows.map((r) => r.entry)), h)
  if (nEff < MIN_EFFECTIVE || variance <= 0) return thin(n)
  const t = mean / Math.sqrt(variance / nEff)
  return {
    status: 'ok',
    n,
    estimate: mean,
    t_stat: t,
    p_value: twoSidedP(t, nEff - 1),
  }
}

/** The first date in the held-out newest third. */
export function holdoutFrom(dates: readonly string[]): string | null {
  if (!dates.length) return null
  const sorted = [...dates].sort()
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * (1 - HOLDOUT_FRACTION)))]!
}

export interface CellResult {
  ticker: string
  horizon: SignalHorizon
  in: SignalStat & { from: string | null; to: string | null }
  out: SignalStat & { from: string | null; to: string | null }
}

const span = (dates: string[]) => ({
  from: dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null,
  to: dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null,
})

export function leadLag(
  changes: readonly Change[],
  panel: PricePanel,
  tickers: readonly string[],
  benchmark: string,
): CellResult[] {
  const cut = holdoutFrom(changes.map((c) => c.available))
  const cells: CellResult[] = []
  for (const ticker of tickers) {
    for (const h of SIGNAL_HORIZONS) {
      const rows = {
        in: [] as { entry: number; x: number; y: number; date: string }[],
        out: [] as { entry: number; x: number; y: number; date: string }[],
      }
      for (const c of changes) {
        const entry = sessionAfter(panel.dates, c.available)
        const y = abnormalReturn(panel, ticker, benchmark, entry, h)
        if (y === null) continue
        rows[cut !== null && c.available >= cut ? 'out' : 'in'].push({
          entry,
          x: c.x,
          y,
          date: c.available,
        })
      }
      cells.push({
        ticker,
        horizon: h,
        in: {
          ...correlationStat(rows.in, h, MIN_SAMPLE.lead_lag.in),
          ...span(rows.in.map((r) => r.date)),
        },
        out: {
          ...correlationStat(rows.out, h, MIN_SAMPLE.lead_lag.out),
          ...span(rows.out.map((r) => r.date)),
        },
      })
    }
  }
  return cells
}

export interface EventPoint {
  date: string
  /** Signs the abnormal return when the series is signed. */
  value: number
  /**
   * Days the event's date could be off by: an event known only to fall
   * between two copies of a page is dated at the first and keeps the gap.
   * Absent or 0 for a dated event.
   */
  window_days?: number
}

/**
 * The widest date window an event may carry at a horizon of h sessions.
 * Below 20 sessions the date must be known to within two days; from 20 on,
 * the window may span up to half the horizon's calendar days, so the return
 * from the close before the window still covers the event.
 */
export function maxWindowDays(h: number): number {
  return h < 20 ? 2 : Math.floor((h * 7) / 10)
}

/** One event a day: same-day events are one market reaction. Values add; the narrowest window holds. */
export function eventDays(events: readonly EventPoint[]): EventPoint[] {
  const by = new Map<string, EventPoint>()
  for (const e of events) {
    const prev = by.get(e.date)
    const window = Math.min(prev?.window_days ?? Infinity, e.window_days ?? 0)
    by.set(e.date, {
      date: e.date,
      value: (prev?.value ?? 0) + e.value,
      ...(window > 0 ? { window_days: window } : {}),
    })
  }
  return [...by.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
}

export function eventStudy(
  events: readonly EventPoint[],
  panel: PricePanel,
  tickers: readonly string[],
  benchmark: string,
  signed: boolean,
): CellResult[] {
  const days = eventDays(events)
  const cut = holdoutFrom(days.map((e) => e.date))
  const cells: CellResult[] = []
  for (const ticker of tickers) {
    for (const h of SIGNAL_HORIZONS) {
      const rows = {
        in: [] as { entry: number; car: number; date: string }[],
        out: [] as { entry: number; car: number; date: string }[],
      }
      for (const e of days) {
        if (signed && e.value === 0) continue
        if ((e.window_days ?? 0) > maxWindowDays(h)) continue
        const base = sessionBefore(panel.dates, e.date)
        const ar = abnormalReturn(panel, ticker, benchmark, base, h)
        if (ar === null) continue
        rows[cut !== null && e.date >= cut ? 'out' : 'in'].push({
          entry: base,
          car: signed ? Math.sign(e.value) * ar : ar,
          date: e.date,
        })
      }
      cells.push({
        ticker,
        horizon: h,
        in: { ...meanStat(rows.in, h, MIN_SAMPLE.event.in), ...span(rows.in.map((r) => r.date)) },
        out: {
          ...meanStat(rows.out, h, MIN_SAMPLE.event.out),
          ...span(rows.out.map((r) => r.date)),
        },
      })
    }
  }
  return cells
}
