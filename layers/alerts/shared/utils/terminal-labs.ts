// How an alert reads in one table row: which lab, which axis, and the one number that
// moved. An alert row stores only a headline and the change ids it cites, so all three are
// read off the cited rows, never the prose; rows that did not resolve read as "—".

import { pctChange, pctLabel, readableEdgarNames } from '../../../core/shared/utils/terminal-format'
import type { AlertView, ChangeView } from '../types/alerts'
import type { ProviderId } from '../../../core/shared/types/common'

export type AlertAxis =
  | 'pricing'
  | 'hiring'
  | 'sec'
  | 'revenue'
  | 'incidents'
  | 'disclosures'
  | 'demand'
  | 'exposure'
  | 'compute'

export const AXIS_DISPLAY: Record<AlertAxis, string> = {
  pricing: 'Prices',
  hiring: 'Hiring',
  sec: 'SEC',
  revenue: 'Revenue',
  incidents: 'Incidents',
  disclosures: 'Disclosures',
  demand: 'Demand',
  exposure: 'Exposure',
  compute: 'Compute',
}

/** Where each axis reads in full. */
export const AXIS_PATH: Record<AlertAxis, string> = {
  pricing: '/prices',
  hiring: '/hiring',
  sec: '/revenue',
  revenue: '/revenue',
  incidents: '/incidents',
  disclosures: '/disclosures',
  demand: '/rankings',
  exposure: '/exposure',
  compute: '/compute',
}

/**
 * Routes an axis alerts on that sit outside its AXIS_PATH page. The GPU median
 * rule reads the prices /api/gpu-prices serves, and they read in full on
 * /compute; the observation rules read what /api/datacenters, /api/limits,
 * /api/pay and /api/adoption serve; the deal-score rule reads the press figures
 * the reported pipeline stores, the table /api/reported serves. The supplier-passage
 * rule reads the passages /api/suppliers serves. `bun run surfaces:check` reads this beside AXIS_PATH.
 */
export const AXIS_ROUTES: Partial<Record<AlertAxis, readonly string[]>> = {
  compute: ['/api/gpu-prices', '/api/datacenters'],
  pricing: ['/api/limits'],
  hiring: ['/api/pay'],
  demand: ['/api/adoption'],
  revenue: ['/api/reported'],
  exposure: ['/api/suppliers'],
}

/** The axis each change entity type sits on. The signal band (terminal-alerts.ts › AXIS_OF) buckets by it too. */
export const ENTITY_AXIS: Record<ChangeView['entity_type'], AlertAxis> = {
  job: 'hiring',
  model: 'pricing',
  recommendation: 'pricing',
  filing: 'sec',
  filer: 'sec',
  document: 'sec',
  offering: 'sec',
  statement: 'revenue',
  commitment: 'sec',
  concentration: 'sec',
  shares: 'sec',
  risk_factors: 'sec',
  revenue: 'revenue',
  incident: 'incidents',
  disclosure: 'disclosures',
  disclosure_timeline: 'disclosures',
  ranking: 'demand',
  filed_fact: 'exposure',
  guidance: 'exposure',
  guidance_check: 'exposure',
  gpu_price: 'compute',
  adoption_series: 'demand',
  data_center: 'compute',
  rate_limit: 'pricing',
  pay_band: 'hiring',
  deal_score: 'revenue',
  revenue_score: 'revenue',
  supplier_passage: 'exposure',
}

export const ALERT_AXES = Object.keys(AXIS_DISPLAY) as [AlertAxis, ...AlertAxis[]]

/** The change entity types that sit on `axis`: what a topic filter matches cited rows against. */
export function entityTypesOf(axis: AlertAxis): ChangeView['entity_type'][] {
  return (Object.keys(ENTITY_AXIS) as ChangeView['entity_type'][]).filter(
    (t) => ENTITY_AXIS[t] === axis,
  )
}

/** Distinct labs across the cited rows, in first-cited order. */
export function alertLabs(alert: Pick<AlertView, 'changes'>): ProviderId[] {
  return [...new Set(alert.changes.map((c) => c.provider))]
}

/**
 * The axis the cited rows sit on; null when they resolve to nothing or disagree.
 * One filing read whole cites rows on both SEC axes: a prospectus alert cites
 * its revenue lines beside the offering and risk-factor rows of the same
 * document. That is a revenue alert (its headline is the revenue figure), so
 * `revenue` with only `sec` beside it reads as revenue, not as a disagreement.
 */
export function alertAxis(alert: Pick<AlertView, 'changes'>): AlertAxis | null {
  const axes = new Set(alert.changes.map((c) => ENTITY_AXIS[c.entity_type]))
  if (axes.size === 2 && axes.has('revenue') && axes.has('sec')) return 'revenue'
  return axes.size === 1 ? [...axes][0]! : null
}

const num = (s: string | null): number | null => {
  if (s === null) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * The one figure that moved, as a short label: a price move as a percent
 * on the input price, a listing as "new" or "delisted", a hiring batch as
 * the net of adds and closes. Null where the rows carry nothing summable —
 * a filing, an incident — and the headline has to do the work.
 */
export function alertDelta(alert: Pick<AlertView, 'changes'>): string | null {
  const rows = alert.changes
  if (rows.length === 0) return null
  const axis = alertAxis(alert)

  if (axis === 'hiring') {
    const added = rows.filter((c) => c.change_type === 'added').length
    const removed = rows.filter((c) => c.change_type === 'removed').length
    if (added === 0 && removed === 0) return null
    const parts = []
    if (added) parts.push(`+${added}`)
    if (removed) parts.push(`−${removed}`)
    return `${parts.join(' ')} roles`
  }

  if (axis === 'pricing') {
    const repriced = rows.find((c) => c.change_type === 'modified')
    if (repriced) {
      const field =
        repriced.diff.find((d) => d.field === 'input_per_mtok') ??
        repriced.diff.find((d) => d.field === 'output_per_mtok')
      const pct = field ? pctChange(num(field.before), num(field.after)) : null
      if (pct !== null)
        return `${pctLabel(pct)} ${field!.field === 'input_per_mtok' ? 'in' : 'out'}`
      return null
    }
    const added = rows.filter((c) => c.change_type === 'added').length
    const removed = rows.filter((c) => c.change_type === 'removed').length
    if (added && !removed) return added === 1 ? 'new SKU' : `${added} new SKUs`
    if (removed && !added) return removed === 1 ? 'delisted' : `${removed} delisted`
    return null
  }

  if (axis === 'compute') {
    const median = rows[0]!.diff.find((d) => d.field === 'median')
    const pct = median ? pctChange(num(median.before), num(median.after)) : null
    return pct === null ? null : `${pctLabel(pct)} median`
  }

  return null
}

/**
 * A headline cut at a word so a table row stays one line; the full text is the
 * link's title. EDGAR's capitals ("NVIDIA CORP") read in the company's case.
 */
export function clipHeadline(raw: string, max = 88): string {
  const text = readableEdgarNames(raw)
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 40)).replace(/[,;:—-]$/, '')}…`
}
