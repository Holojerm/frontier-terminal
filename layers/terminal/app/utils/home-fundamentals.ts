// The front page's row of fundamentals around the labs: press against filings,
// the listed companies tied to a lab, GPU rental prices, utilization, and the
// newest thesis status change. Each function is a `useFetch` transform, so the
// page's hydration payload holds five small figures instead of five payloads.

import type { ListedData } from '../../shared/utils/listed'
import type { Bounds, UtilizationData } from '../../shared/utils/recipe-views'
import { count, money, percent } from '../../shared/utils/terminal-format'
import { labName } from '../../shared/utils/terminal-labs'
import type { GpuPricesData, GroundTruthData, Prov } from '../../shared/utils/terminal-types'
import { dayLabel, STATUS_META, thesisPath } from '../../shared/utils/thesis-format'
import type { ThesesData } from '../../shared/utils/thesis-types'
import type { GapRef } from '../types/terminal-ui'

export interface FundamentalFigure {
  label: string
  value: string | null
  sub: string | null
  /** The page section that shows this figure in full. */
  to: string
  source: (Prov & { label?: string }) | null
  gap: GapRef | null
}

const figure = (f: Pick<FundamentalFigure, 'label' | 'to'> & Partial<FundamentalFigure>) => ({
  value: null,
  sub: null,
  source: null,
  gap: null,
  ...f,
})

const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`

const sharePct = (n: number) => percent(n * 100)
const range = (b: Bounds) =>
  sharePct(b.low) === sharePct(b.high) ? sharePct(b.low) : `${sharePct(b.low)}–${sharePct(b.high)}`

const newest = <T extends Prov>(rows: readonly T[]): T | null =>
  rows.reduce<T | null>((a, r) => (!a || r.fetched_at > a.fetched_at ? r : a), null)

const prov = (p: Prov | null, label?: string): FundamentalFigure['source'] =>
  p ? { source_url: p.source_url, fetched_at: p.fetched_at, ...(label ? { label } : {}) } : null

/** The median press report against the filed revenue figure, cited to the newest filing scored. */
export function truthFigure(d: GroundTruthData): FundamentalFigure {
  const t = d.tally
  const base = { label: 'Press against filings', to: '/ground-truth#summary' }
  if (t.reports === 0 || t.median_abs_error_pct === null) {
    return figure({
      ...base,
      gap: {
        title: 'No report scored yet',
        reason: 'No filing has printed a revenue figure the press reported first.',
      },
    })
  }
  const filed = d.resolutions[0]
  return figure({
    ...base,
    value: percent(t.median_abs_error_pct),
    sub: `Median error of ${plural(t.reports, 'report')} against ${plural(t.periods, 'filed figure')}`,
    source: filed ? prov(filed.filed, `${labName(filed.lab)} ${filed.filed.form}`) : null,
  })
}

/** How many listed companies a filing or a cited page ties to a tracked lab. */
export function listedFigure(d: ListedData): FundamentalFigure {
  const n = d.counts
  const base = { label: 'Listed companies', to: '/dependencies#listed' }
  if (n.companies === 0) {
    return figure({ ...base, gap: { title: 'No listed company named yet' } })
  }
  return figure({
    ...base,
    value: count(n.lab_tied),
    sub: `Tied to a lab by a filing or a site, of ${count(n.companies)} we list`,
  })
}

/** The H100 median rental price, cited to the newest provider page counted. */
export function gpuFigure(d: GpuPricesData): FundamentalFigure {
  const h100 = d.medians.find((m) => m.gpu === 'H100')
  const base = { label: 'H100 rental', to: '/compute#gpu' }
  if (!h100 || h100.median === null) {
    return figure({ ...base, gap: { title: 'No H100 price at the last check' } })
  }
  return figure({
    ...base,
    value: money(h100.median),
    sub: `Median on-demand $ per GPU-hour, ${plural(h100.providers.length, 'provider')}`,
    source: prov(newest(h100.providers)),
  })
}

/**
 * The first utilization reading /compute shows: spot against on-demand once
 * enough providers print spot, then CoreWeave's billed share of its power,
 * then OpenRouter's average day against its busiest.
 */
export function utilizationFigure(d: UtilizationData): FundamentalFigure {
  const label = 'Utilization'
  const spot = d.spot.combined.find((c) => c.ratio !== null)
  if (spot?.ratio) {
    return figure({
      label,
      to: '/compute#spot',
      value: range(spot.ratio),
      sub: `${spot.gpu} spot as a share of on-demand, median of ${plural(spot.providers, 'provider')}`,
      source: prov(newest(d.spot.providers.filter((p) => p.gpu === spot.gpu))),
    })
  }
  const cw = d.coreweave
  if (cw?.floor) {
    return figure({
      label,
      to: '/compute#revenue-per-mw',
      value: range(cw.floor.share),
      sub: `CoreWeave’s ${cw.floor.quarter} revenue as a share of what its power bills at list price`,
      source: prov(newest(cw.sources)),
    })
  }
  const shape = d.demand_shape
  if (d.implied && shape) {
    return figure({
      label,
      to: '/compute#implied-load',
      value: sharePct(shape.ratio),
      sub: `OpenRouter’s average day against its busiest, last ${plural(shape.days, 'day')}`,
      source: prov(shape.source),
    })
  }
  const most = Math.max(0, ...d.spot.combined.map((c) => c.providers))
  return figure({
    label,
    to: '/compute#spot',
    gap: {
      title: 'No utilization reading yet',
      reason: `${most} of the ${d.spot.providers_needed} providers we need print a spot price.`,
    },
  })
}

/** The claim whose status changed last, cited to the reading or verdict behind it. */
export function thesisFigure(d: ThesesData): FundamentalFigure {
  const claims = d.theses.flatMap((t) => t.claims.map((c) => ({ t, c })))
  const last = claims.reduce<(typeof claims)[number] | null>(
    (a, x) => (x.c.status_since && (!a || x.c.status_since > a.c.status_since!) ? x : a),
    null,
  )
  const base = { label: 'Newest thesis change', to: '/theses' }
  if (!last) return figure({ ...base, gap: { title: 'No claim has a status yet' } })
  const { t, c } = last
  return figure({
    ...base,
    to: `${thesisPath(t.id)}#claim-${c.n}`,
    value: STATUS_META[c.status].label,
    sub: `${t.title} thesis, claim ${c.n}, since ${dayLabel(c.status_since!.slice(0, 10))}`,
    source: prov(c.verdicts[0] ?? c.latest),
  })
}
