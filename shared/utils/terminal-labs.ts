// How an alert reads in one table row: which lab, which axis, and the one
// number that moved. An alert row stores none of these — it stores a
// headline and the change ids it cites — so all three are read off the
// cited rows, never off the prose. An alert whose rows did not resolve
// reads as "—" on every column rather than as a guess.

import { pctChange, pctLabel } from './terminal-format'
import type { AlertView, ChangeView, ProviderId } from './terminal-types'

export const LAB_DISPLAY: Record<ProviderId, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  xai: 'xAI',
  other: 'Other',
}

export type AlertAxis = 'pricing' | 'hiring' | 'sec' | 'revenue' | 'incidents' | 'demand'

export const AXIS_DISPLAY: Record<AlertAxis, string> = {
  pricing: 'Prices',
  hiring: 'Hiring',
  sec: 'SEC',
  revenue: 'Revenue',
  incidents: 'Incidents',
  demand: 'Demand',
}

/** Where each axis reads in full. */
export const AXIS_PATH: Record<AlertAxis, string> = {
  pricing: '/prices',
  hiring: '/hiring',
  sec: '/revenue',
  revenue: '/revenue',
  incidents: '/incidents',
  demand: '/rankings',
}

const AXIS_OF: Record<ChangeView['entity_type'], AlertAxis> = {
  job: 'hiring',
  model: 'pricing',
  recommendation: 'pricing',
  filing: 'sec',
  filer: 'sec',
  revenue: 'revenue',
  incident: 'incidents',
  ranking: 'demand',
}

/** Distinct labs across the cited rows, in first-cited order. */
export function alertLabs(alert: Pick<AlertView, 'changes'>): ProviderId[] {
  return [...new Set(alert.changes.map((c) => c.provider))]
}

/** The axis the cited rows sit on; null when they resolve to nothing or disagree. */
export function alertAxis(alert: Pick<AlertView, 'changes'>): AlertAxis | null {
  const axes = new Set(alert.changes.map((c) => AXIS_OF[c.entity_type]))
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

  return null
}

/** A headline cut at a word so a table row stays one line; the full text is the link's title. */
export function clipHeadline(text: string, max = 88): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 40)).replace(/[,;:—-]$/, '')}…`
}
