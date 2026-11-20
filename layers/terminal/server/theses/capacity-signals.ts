// The Compute thesis's capacity signals, added 2026-11-20: what GPU owners
// charge for capacity they can take back, whether the filers that pay for the
// buildout still guide the same capex, and whether the labs' own endpoints
// slow down in working hours. Each reads rows another part of the site
// already stores (GPU price recipes, earnings releases, hourly probes); none
// fetches anything. The arithmetic is pure and exported for
// layers/terminal/test/theses-capacity.test.ts.

import { gte } from 'drizzle-orm'

import type { ExposureTicker } from '../../shared/utils/terminal-exposure'
import type { SignalSpec } from '../../shared/utils/thesis-types'

import * as tables from '#server/db/schema'
import type { ProbeDayRow } from '#server/db/schema'
import { FILER_NAMES, type StoredFact } from '../exposure/series'
import type { PipelineDb } from '../pipeline/store'
import { filedFactsAt } from '../utils/terminal-exposure'
import {
  filedActual,
  fiscalYear,
  GUIDANCE_MEASURES,
  type StoredGuidance,
} from '../utils/terminal-ground-truth-guidance'
import { daysBefore } from '../utils/terminal-rankings'
import { spotRead } from '../utils/terminal-utilization'
import { gpuState, median, type GpuObservation } from './compute-signals'
import type { SignalDeps, SignalReading } from './signals'

type Spec<S extends string> = Extract<SignalSpec, { signal: S }>

const round = (n: number, places = 4) => Math.round(n * 10 ** places) / 10 ** places

interface Prov {
  source_url: string
  fetched_at: string
}
const newest = <T extends Prov>(xs: readonly T[]): T =>
  xs.reduce((a, b) => (b.fetched_at > a.fetched_at ? b : a))
const pick = (p: Prov): Prov => ({ source_url: p.source_url, fetched_at: p.fetched_at })

// ---- spot against on-demand ----------------------------------------------------

export interface SpotProvider extends Prov {
  on_demand: number
  spot_low: number
  spot_high: number
  /** The middle of the spot range over the on-demand price. */
  ratio: number
}

/**
 * Per provider that prints a spot price for `gpu` beside its on-demand price,
 * the middle of its spot range over on-demand; and the median of those. Null
 * when no provider prints one.
 */
export function spotToOnDemand(
  gpu: Spec<'gpu-spot-to-on-demand'>['gpu'],
  observations: readonly GpuObservation[],
): { value: number; providers: Record<string, SpotProvider> } | null {
  const providers: Record<string, SpotProvider> = {}
  for (const p of spotRead(observations).providers) {
    if (p.gpu !== gpu) continue
    providers[p.provider] = {
      on_demand: round(p.on_demand),
      spot_low: round(p.spot.low),
      spot_high: round(p.spot.high),
      ratio: round((p.ratio.low + p.ratio.high) / 2),
      ...pick(p),
    }
  }
  const value = median(Object.values(providers).map((p) => p.ratio))
  return value === null ? null : { value: round(value), providers }
}

/** Today's spot price over on-demand for one GPU, across the providers whose page prints both. */
export async function gpuSpotToOnDemand(
  db: PipelineDb,
  spec: Spec<'gpu-spot-to-on-demand'>,
  deps: SignalDeps,
): Promise<SignalReading[]> {
  const state = await gpuState(db)
  const read = spotToOnDemand(spec.gpu, state.observations)
  if (!read) return []
  const have = Object.keys(read.providers).length
  return [
    {
      date: deps.now().toISOString().slice(0, 10),
      value: read.value,
      detail: {
        gpu: spec.gpu,
        spot_providers: read.providers,
        gpu_failed: state.failed,
        quorum: { have, need: spec.min_providers },
        void_reason:
          have < spec.min_providers
            ? `${have} of the ${spec.min_providers} providers this reading needs print a spot price for the ${spec.gpu}.`
            : null,
        compare: null,
      },
      ...pick(newest(Object.values(read.providers))),
    },
  ]
}

// ---- capex guidance -------------------------------------------------------------

const midpoint = (g: { low: number; high: number }) => (g.low + g.high) / 2

export interface GuidanceFiler {
  filer: string
  state: 'ok' | 'cut' | 'under'
  /** The fiscal year still running that the filer guides, at its newest release. Null with none. */
  guided: {
    fiscal_year: number
    low: number
    high: number
    filed: string
    releases: number
    /** The highest midpoint an earlier release printed for the same year. Null on the first. */
    peak_midpoint: number | null
    /** How far the newest midpoint sits below that peak, 0 when at or above it. */
    cut: number | null
  } | null
  /** The year that last ended, once its capex is filed: the filed figure against the last guidance before it. */
  landed: {
    fiscal_year: number
    low: number
    high: number
    actual: number
    /** How far the filed figure sits below the low end, 0 when at or above it. */
    under: number
  } | null
}

export interface GuidanceShortfalls {
  /** Filers that cut or landed under. */
  value: number
  filers: Partial<Record<ExposureTicker, GuidanceFiler>>
  /** Filers with nothing to read, and why. */
  no_figure: Partial<Record<ExposureTicker, { filer: string; reason: string }>>
  prov: Prov
}

/**
 * Each filer's capex guidance, read two ways. A cut: for a fiscal year still
 * running on `today`, the newest release's midpoint against the highest
 * midpoint an earlier release printed for that year. A landing: for the year
 * that last ended, the capex the 10-K filed against the low end of the last
 * guidance before it. A filer counts once, however it falls short. Null when
 * no filer has either.
 */
export function guidanceShortfalls(
  guidance: readonly StoredGuidance[],
  facts: readonly StoredFact[],
  today: string,
  spec: Pick<Spec<'capex-guidance-shortfalls'>, 'cut' | 'under'>,
): GuidanceShortfalls | null {
  const filers: GuidanceShortfalls['filers'] = {}
  const no_figure: GuidanceShortfalls['no_figure'] = {}
  const read: StoredGuidance[] = []
  for (const ticker of Object.keys(GUIDANCE_MEASURES) as ExposureTicker[]) {
    const own = guidance
      .filter((g) => g.ticker === ticker)
      .sort(
        (a, b) => a.filed.localeCompare(b.filed) || a.accession_no.localeCompare(b.accession_no),
      )
    const ended = (g: StoredGuidance) => fiscalYear(ticker, g.fiscal_year).end < today

    // The running year with the deepest cut; with no cut, the nearest one.
    let guided: GuidanceFiler['guided'] = null
    const running = [...new Set(own.filter((g) => !ended(g)).map((g) => g.fiscal_year))].sort()
    for (const year of running) {
      const releases = own.filter((g) => g.fiscal_year === year)
      const last = releases.at(-1)!
      const earlier = releases.slice(0, -1)
      const peak = earlier.length ? Math.max(...earlier.map(midpoint)) : null
      const cut = peak === null ? null : round(Math.max(0, 1 - midpoint(last) / peak))
      if (!guided || (cut ?? 0) > (guided.cut ?? 0)) {
        guided = {
          fiscal_year: year,
          low: last.low,
          high: last.high,
          filed: last.filed,
          releases: releases.length,
          peak_midpoint: peak,
          cut,
        }
      }
      read.push(...releases)
    }

    let landed: GuidanceFiler['landed'] = null
    const lastEnded = Math.max(...own.filter(ended).map((g) => g.fiscal_year))
    const actual = Number.isFinite(lastEnded) ? filedActual(ticker, lastEnded, facts) : null
    if (actual) {
      const before = own.filter((g) => g.fiscal_year === lastEnded && g.filed < actual.first_filed)
      const last = before.at(-1)
      if (last) {
        landed = {
          fiscal_year: lastEnded,
          low: last.low,
          high: last.high,
          actual: actual.value,
          under: round(Math.max(0, 1 - actual.value / last.low)),
        }
        read.push(...before)
      }
    }

    if (!guided && !landed) {
      no_figure[ticker] = {
        filer: FILER_NAMES[ticker],
        reason:
          GUIDANCE_MEASURES[ticker].gap ??
          (own.length
            ? 'No release guides a fiscal year that is still running.'
            : 'No release we read prints a capex figure.'),
      }
      continue
    }
    filers[ticker] = {
      filer: FILER_NAMES[ticker],
      state:
        landed && landed.under >= spec.under
          ? 'under'
          : guided && (guided.cut ?? 0) >= spec.cut
            ? 'cut'
            : 'ok',
      guided,
      landed,
    }
  }
  if (read.length === 0) return null
  return {
    value: Object.values(filers).filter((f) => f.state !== 'ok').length,
    filers,
    no_figure,
    prov: pick(newest(read)),
  }
}

/** How many filers have cut their capex guidance or filed capex under it, as of today. */
export async function capexGuidanceShortfalls(
  db: PipelineDb,
  spec: Spec<'capex-guidance-shortfalls'>,
  deps: SignalDeps,
): Promise<SignalReading[]> {
  const [guidance, facts] = await Promise.all([
    db.select().from(tables.filedGuidance),
    filedFactsAt(db, null),
  ])
  const today = deps.now().toISOString().slice(0, 10)
  const read = guidanceShortfalls(guidance, facts, today, spec)
  if (!read) return []
  return [
    {
      date: today,
      value: read.value,
      detail: {
        guidance_filers: read.filers,
        no_figure: read.no_figure,
        thresholds: { cut: spec.cut, under: spec.under },
        compare: null,
      },
      ...read.prov,
    },
  ]
}

// ---- peak against off-peak throughput ---------------------------------------------

type ProbeDay = Pick<
  ProbeDayRow,
  | 'lab'
  | 'day'
  | 'model'
  | 'probes'
  | 'rate_limited'
  | 'failed'
  | 'peak_tps'
  | 'offpeak_tps'
  | 'source_url'
  | 'fetched_at'
>

/**
 * One reading per complete day: over the `days` up to it, each lab's median
 * peak-hours throughput over its median off-peak throughput, on the model it
 * ran last, and the median of those across labs. A lab is compared only with
 * itself; the labs' speeds are never compared with each other. The share of
 * probes that were rate limited or failed is recorded beside it and read by
 * no rule.
 */
export function peakThroughputReadings(
  rows: readonly ProbeDay[],
  today: string,
  spec: Pick<Spec<'probe-peak-to-offpeak'>, 'days' | 'min_days' | 'min_labs'>,
): SignalReading[] {
  const complete = rows.filter((r) => r.day < today)
  const labs = [...new Set(complete.map((r) => r.lab))].sort()
  const out: SignalReading[] = []
  for (const end of [...new Set(complete.map((r) => r.day))].sort()) {
    const from = daysBefore(end, spec.days - 1)
    const window = complete.filter((r) => r.day >= from && r.day <= end)
    if (window.length === 0) continue
    const ratios: Record<string, number> = {}
    const left_out: Record<string, string> = {}
    for (const lab of labs) {
      const own = window.filter((r) => r.lab === lab).sort((a, b) => a.day.localeCompare(b.day))
      const model = own.at(-1)?.model
      const both = own.filter(
        (r) => r.model === model && r.peak_tps !== null && r.offpeak_tps !== null,
      )
      const off = median(both.map((r) => r.offpeak_tps!))
      if (both.length < spec.min_days || !off) {
        left_out[lab] =
          `${both.length} of the ${spec.min_days} days it needs with a peak and an off-peak median`
        continue
      }
      ratios[lab] = round(median(both.map((r) => r.peak_tps!))! / off, 3)
    }
    const value = median(Object.values(ratios))
    if (value === null) continue
    const have = Object.keys(ratios).length
    const probes = window.reduce((n, r) => n + r.probes, 0)
    const strained = window.reduce((n, r) => n + r.rate_limited + r.failed, 0)
    out.push({
      date: end,
      value: round(value, 3),
      detail: {
        window: { from, to: end },
        ratios,
        left_out,
        strained_share: probes > 0 ? round(strained / probes, 3) : null,
        quorum: { have, need: spec.min_labs },
        void_reason:
          have < spec.min_labs
            ? `${have} of the ${spec.min_labs} labs this reading needs had ${spec.min_days} days of peak and off-peak probes.`
            : null,
        compare: null,
      },
      ...pick(newest(window)),
    })
  }
  return out
}

/** The labs' peak-hours throughput against off-peak, from the daily roll of the hourly probes. */
export async function probePeakToOffpeak(
  db: PipelineDb,
  spec: Spec<'probe-peak-to-offpeak'>,
  deps: SignalDeps,
  historyDays: number,
): Promise<SignalReading[]> {
  const today = deps.now().toISOString().slice(0, 10)
  const rows = await db
    .select()
    .from(tables.probeDays)
    .where(gte(tables.probeDays.day, daysBefore(today, historyDays + spec.days)))
  return peakThroughputReadings(rows, today, spec)
}
