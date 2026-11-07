// One lab on one printed page: the lab page's readout, the hyperscaler lines
// that name the lab, the newest alerts and the thesis, each figure numbered
// against a source list at the foot. Built from the same payloads the lab
// page reads, through summarizeLab, so the sheet and the lab page cannot
// disagree about a number.
//
// A printed page has no tooltips or popovers, so every gap carries its reason
// as text and every citation is a numbered footnote with the URL spelled out.

import type {
  ExposureData,
  ExposurePoint,
  ExposureSeries,
} from '../../shared/utils/terminal-exposure'
import {
  UTC_STYLE,
  absoluteStamp,
  compactUsd,
  count,
  money,
  periodLabel,
  ppLabel,
  sharePct,
  signed,
  type StampStyle,
} from '../../shared/utils/terminal-format'
import { summarizeLab, type LabInputs } from '../../shared/utils/terminal-lab-summary'
import type { AlertSeverity } from '../../shared/utils/terminal-tiers'
import { SAME_PRICE, moveText, priceCitation, priceMoves } from './price-display'
import type {
  IncidentsData,
  LabId,
  ModelClassId,
  PriceDeltaView,
  PricesData,
  Prov,
  RevenueProviderView,
} from '../../shared/utils/terminal-types'
import { statusCounts, STATUS_META, thesisPath } from '../../shared/utils/thesis-format'
import type { ThesesData } from '../../shared/utils/thesis-types'
import { feedGap } from './feed-gap'

/** How many alerts the sheet lists: enough to show what moved, few enough to fit the page. */
export const SHEET_ALERTS = 5
/** How many revenue periods: the newest filing usually reports a quarter and its year to date. */
export const SHEET_PERIODS = 4

export interface SheetGap {
  title: string
  reason: string | null
}

export interface SheetSource {
  n: number
  label: string
  url: string
  fetched_at: string
}

export interface SheetPrice {
  class: ModelClassId
  label: string
  model: string | null
  input: string
  output: string
  /** The newest change on the row, as a reader says it. */
  change: string
  gap: SheetGap | null
  ref: number | null
}

export interface SheetLine {
  key: string
  label: string
  period: string
  value: string
  ref: number
}

export interface SheetFigure {
  label: string
  value: string | null
  /** The change beside the value, its sign always visible. */
  delta: string | null
  lines: string[]
  gap: SheetGap | null
  ref: number | null
}

export interface SheetAlert {
  id: string
  date: string
  severity: AlertSeverity
  headline: string
  ref: number
}

export interface TearSheet {
  lab: LabId
  display: string
  prices: SheetPrice[]
  /** The vendor's tier the matrix reads, stated once. */
  tierNote: string | null
  revenue: { scope: string | null; lines: SheetLine[]; gap: SheetGap | null }
  exposure: { lines: SheetLine[]; gaps: SheetGap[]; filers: number }
  demand: SheetFigure
  hiring: SheetFigure
  incidents: SheetFigure
  alerts: SheetAlert[]
  thesis: {
    path: string
    title: string
    stance: string
    claims: number
    statuses: string
  } | null
  /** Upstream attribution a source requires (OpenRouter's CC BY string), verbatim. */
  citations: string[]
  sources: SheetSource[]
}

export interface TearSheetInputs extends LabInputs {
  /** Only `matrix` is read; `tier_note` is printed under the price table. */
  prices?: Pick<PricesData, 'matrix'> | null
  /** `window_days` names the incident window on the sheet. */
  incidents?: Pick<IncidentsData, 'providers' | 'window_days'> | null
  exposure?: Pick<ExposureData, 'series' | 'gaps' | 'filers'> | null
  theses?: Pick<ThesesData, 'theses'> | null
}

/**
 * A URL short enough for a printed footnote: no scheme, no `www.`, no query,
 * and a long path cut to its host and last segment.
 * 'sec.gov/…/msft-20260930_htm.xml'.
 */
export function shortUrl(url: string, max = 56): string {
  const clip = (s: string) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return clip(url)
  }
  const host = u.host.replace(/^www\./, '')
  const path = u.pathname.replace(/\/+$/, '')
  if (host.length + path.length <= max) return `${host}${path}`
  const last = path.split('/').filter(Boolean).at(-1) ?? ''
  return clip(`${host}/…/${last}`)
}

/**
 * '2026-11-04 18:00Z': a fetch time a printed page can carry without a year
 * being dropped. Always the ISO date, in the reader's zone and clock.
 */
export function shortStamp(iso: string, style: StampStyle = UTC_STYLE): string {
  return absoluteStamp(iso, null, { ...style, iso: true })
}

const day = (iso: string) => iso.slice(0, 10)

/** The newest change on a price row: 'Listed 2026-09-22', 'In $3.00 → $2.00 (−33.3%) on 2026-10-07'. */
export function priceChangeLabel(delta: PriceDeltaView | null): string {
  if (delta === null) return 'None on record'
  const on = day(delta.detected_at)
  if (delta.change_type === 'added') return `Listed ${on}`
  if (delta.change_type === 'removed') return `Delisted ${on}`
  const moves = priceMoves(delta).map(moveText)
  if (moves.length === 0) return `Edited ${on}, ${SAME_PRICE}`
  const text = moves.join(', ')
  return `${text.charAt(0).toUpperCase()}${text.slice(1)} on ${on}`
}

/** One exposure value as filed: dollars, a percentage, or a share count. */
export function exposureValue(series: Pick<ExposureSeries, 'unit'>, v: number): string {
  if (series.unit === 'USD') return compactUsd(v)
  if (series.unit === 'pure') return `${Math.round(v * 1000) / 10}%`
  return `${count(v)}${series.unit === 'shares' ? ' shares' : ''}`
}

/** The span an exposure value covers: a balance date, a quarter, or a longer flow. */
export function exposurePeriod(p: Pick<ExposurePoint, 'months' | 'end'>): string {
  if (p.months === null) return `at ${p.end}`
  return p.months === 3 ? `quarter to ${p.end}` : `${p.months} months to ${p.end}`
}

/** Whose revenue the lines are, when it isn't the lab's own filing. */
function revenueScopeLine(view: RevenueProviderView | null): string | null {
  const f = view?.filer
  if (!f || view?.disclosure !== 'parent') return null
  const parent = f.entity_name ?? f.ticker ?? 'the parent'
  const ticker = f.ticker && f.entity_name ? ` (${f.ticker})` : ''
  return f.segment_label
    ? `${f.segment_label} segment, as ${parent}${ticker} reports it. It’s the parent’s figure.`
    : `All of ${parent}${ticker}, the parent. It’s the parent’s figure.`
}

/** Every figure on the sheet, with its footnote numbers resolved against one source list. */
export function buildTearSheet(
  lab: LabId,
  input: TearSheetInputs,
  style: StampStyle = UTC_STYLE,
): TearSheet {
  const s = summarizeLab(lab, input)

  const sources: SheetSource[] = []
  const byUrl = new Map<string, SheetSource>()
  const cite = (prov: Prov, label: string): number => {
    const seen = byUrl.get(prov.source_url)
    if (seen) {
      if (prov.fetched_at > seen.fetched_at) seen.fetched_at = prov.fetched_at
      return seen.n
    }
    const src = {
      n: sources.length + 1,
      label,
      url: prov.source_url,
      fetched_at: prov.fetched_at,
    }
    sources.push(src)
    byUrl.set(src.url, src)
    return src.n
  }

  const matrix = input.prices?.matrix ?? null
  const prices: SheetPrice[] = (matrix?.classes ?? []).map((c) => {
    const cell = matrix!.cells.find((x) => x.provider === lab && x.class === c.id) ?? null
    const row = cell?.row ?? null
    if (!cell?.priced || !row) {
      return {
        class: c.id,
        label: c.label,
        model: row?.model_slug ?? null,
        input: '',
        output: '',
        change: '',
        gap: {
          title: row ? 'No published price' : 'Not mapped',
          reason: cell?.gap ?? null,
        },
        ref: row ? cite(priceCitation(row), `${s.display} pricing`) : null,
      }
    }
    return {
      class: c.id,
      label: c.label,
      model: row.model_slug,
      input: money(row.input_per_mtok),
      output: money(row.output_per_mtok),
      change: priceChangeLabel(row.delta),
      gap: null,
      ref: cite(priceCitation(row), `${s.display} pricing`),
    }
  })

  const rv = s.revenue.view
  const revenueLines: SheetLine[] = (rv?.periods ?? []).slice(0, SHEET_PERIODS).map((p) => ({
    key: p.entity_key,
    label: `${p.form} filed ${p.filed}`,
    period: `${periodLabel(p.days)} to ${p.end}${p.unaudited ? ', unaudited' : ''}`,
    value: compactUsd(p.val),
    ref: cite(p, `${p.form} filed ${p.filed}`),
  }))
  const revenueGap: SheetGap | null = revenueLines.length
    ? null
    : rv?.disclosure === 'no_rows'
      ? {
          title: 'Not read yet',
          reason:
            rv.filer?.relation === 'issuer'
              ? 'S-1 filed. We haven’t read revenue from it yet.'
              : 'We know the filer. We haven’t read revenue from its tagged data yet.',
        }
      : {
          title: 'None filed',
          reason:
            'No SEC filing reports this lab’s revenue. We don’t use run-rates from press reports.',
        }

  const exposure = input.exposure ?? null
  const exposureLines: SheetLine[] = (exposure?.series ?? [])
    .filter((x) => x.group === lab && x.points.length > 0)
    .map((x) => {
      const p = x.points.at(-1)!
      return {
        key: x.id,
        label: `${x.filer}: ${x.label}`,
        period: exposurePeriod(p),
        value: exposureValue(x, p.value),
        ref: cite(p, `${x.ticker} ${p.form} filed ${p.filed}`),
      }
    })
  const exposureGaps: SheetGap[] = (exposure?.gaps ?? [])
    .filter((g) => g.group === lab)
    .map((g) => ({ title: g.title, reason: g.reason }))

  const citations: string[] = []
  const d = s.demand
  const rankings = input.rankings ?? null
  const window = rankings?.meta.coverage.window ?? null
  const prior = rankings?.meta.coverage.prior_window ?? null
  const demand: SheetFigure =
    d && d.share !== null && rankings?.provenance
      ? {
          label: 'OpenRouter share of all tokens',
          value: sharePct(d.share),
          // The prior window can be shorter than seven days while the feed is
          // young, so the delta names the span it was taken against.
          delta:
            d.delta_pp === null || !prior
              ? null
              : `${ppLabel(d.delta_pp)} on ${prior.from} to ${prior.to}`,
          lines: [
            `Every provider’s tokens counted, ${window ? `${window.from} to ${window.to}` : 'last 7 days'}.`,
          ],
          gap: null,
          ref: cite(rankings.provenance, 'OpenRouter rankings'),
        }
      : {
          label: 'OpenRouter share of all tokens',
          value: null,
          delta: null,
          lines: [],
          gap: { title: 'No rankings data yet', reason: null },
          ref: null,
        }
  if (demand.ref !== null && rankings?.meta.citation) citations.push(rankings.meta.citation)

  const h = s.hiring
  const hiringSource = h.view?.sources[0] ?? null
  const cluster = h.cluster
  const hiringGap = h.view ? feedGap('hiring', h.view) : null
  const hiring: SheetFigure =
    h.now !== null
      ? {
          label: 'Open roles',
          value: count(h.now),
          delta: h.delta === null ? null : `${signed(h.delta)} in ${h.days} days`,
          lines: [
            ...(cluster
              ? [
                  `${cluster.label}: ${count(cluster.now)}${
                    cluster.then === null
                      ? ', no earlier count.'
                      : `, ${signed(cluster.now - cluster.then)} in ${h.days} days.`
                  }`,
                ]
              : []),
          ],
          gap: null,
          ref: hiringSource ? cite(hiringSource, hiringSource.label) : null,
        }
      : {
          label: 'Open roles',
          value: null,
          delta: null,
          lines: [],
          gap: hiringGap
            ? { title: hiringGap.title, reason: hiringGap.reason ?? null }
            : { title: 'No parsed roles yet', reason: null },
          ref: null,
        }

  const i = s.incidents
  const incidentSource = i?.sources[0] ?? null
  const days = input.incidents?.window_days ?? 30
  const incidentGap = i ? feedGap('incidents', i) : null
  const incidents: SheetFigure =
    i?.feed === 'ok'
      ? {
          label: `Incidents, ${days} days`,
          value: String(i.last_window),
          delta: `${i.prior_window} in the ${days} days before`,
          lines: [
            i.open.length ? `${i.open.length} open now.` : 'None open now.',
            ...(i.window_to
              ? [`Counted to ${shortStamp(i.window_to, style)}, our last read of the feed.`]
              : []),
          ],
          gap: null,
          ref: incidentSource ? cite(incidentSource, incidentSource.label) : null,
        }
      : {
          label: `Incidents, ${days} days`,
          value: null,
          delta: null,
          lines: [],
          gap: incidentGap
            ? { title: incidentGap.title, reason: incidentGap.reason ?? null }
            : { title: 'No parsed incidents yet', reason: null },
          ref: null,
        }

  const alerts: SheetAlert[] = s.alerts
    .filter((a) => a.severity !== 'info')
    .slice(0, SHEET_ALERTS)
    .map((a) => ({
      id: a.id,
      date: day(a.created_at),
      severity: a.severity,
      headline: a.headline,
      ref: cite(a, `Read for the ${day(a.created_at)} alert`),
    }))

  const t = input.theses?.theses.find((x) => x.company === lab) ?? null
  const thesis = t
    ? {
        path: thesisPath(t.id),
        title: t.title,
        stance: t.stance === 'bullish' ? 'Bullish' : 'Bearish',
        claims: t.claims.length,
        statuses: statusCounts(t.claims)
          .map((c) => `${c.n} ${STATUS_META[c.status].label.toLowerCase()}`)
          .join(', '),
      }
    : null

  return {
    lab,
    display: s.display,
    prices,
    tierNote: matrix?.tier_note ?? null,
    revenue: { scope: revenueScopeLine(rv), lines: revenueLines, gap: revenueGap },
    exposure: { lines: exposureLines, gaps: exposureGaps, filers: exposure?.filers.length ?? 0 },
    demand,
    hiring,
    incidents,
    alerts,
    thesis,
    citations,
    sources,
  }
}
