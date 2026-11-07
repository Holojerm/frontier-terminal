// How a like-for-like cell reads: the vendor sentence behind the mapping,
// and the move since the previous revision. Shared by the matrix and the
// front page's flagship grid so one cell never explains itself two ways.

import { absoluteStamp, money, pctChange, pctLabel } from '../../shared/utils/terminal-format'
import type {
  MatrixCell,
  PriceDeltaView,
  PriceRowView,
  Prov,
} from '../../shared/utils/terminal-types'

/** The vendor sentence behind a cell, and the last poll's word on whether it is still there. */
export function basisText(
  c: MatrixCell,
  label: string,
  at: (iso: string) => string = absoluteStamp,
): string {
  const mapped = `We map this to “${label}” because the vendor says “${c.basis}” (${c.basis_source_id}).`
  if (c.basis_current === false) return `${mapped} ${c.basis_note ?? ''}`.trim()
  if (c.basis_current === true && c.basis_checked_at) {
    return `${mapped} Still on the page at our last check, ${at(c.basis_checked_at)}.`
  }
  return mapped
}

/**
 * A price row as one citation: its newest read that still showed it. That
 * read's snapshot carries the same price, and the row's own fetched_at only
 * says when the price last changed.
 */
export function priceCitation(row: PriceRowView): Prov {
  return { source_url: row.source_url, fetched_at: row.checked_at ?? row.fetched_at }
}

export interface PriceMove {
  side: 'in' | 'out' | 'cached'
  before: number | null
  after: number | null
  /** Null when either side is missing or the base is zero. */
  pct: number | null
}

/** What a modified row says when none of its price fields moved. */
export const SAME_PRICE = 'same price'

/**
 * The price fields a modified row moved, input then output then cached. A
 * field that held its value is not a move: reading the input first whatever
 * it did printed an output-only cut as "0% in". The matrix, the price table
 * and the tear sheet all read moves from here, so they name the same field.
 */
export function priceMoves(d: PriceDeltaView): PriceMove[] {
  const sides: [PriceMove['side'], number | null, number | null][] = [
    ['in', d.input_before, d.input_after],
    ['out', d.output_before, d.output_after],
    ['cached', d.cached_before, d.cached_after],
  ]
  return sides
    .filter(([, before, after]) => before !== after)
    .map(([side, before, after]) => ({ side, before, after, pct: pctChange(before, after) }))
}

/** 'in $3.00 → $2.00 (−33.3%)'; no percent when there is no base to take one from. */
export function moveText(m: PriceMove): string {
  const pct = m.pct === null ? '' : ` (${pctLabel(m.pct)})`
  return `${m.side} ${money(m.before)} → ${money(m.after)}${pct}`
}

/** The cell's move since the previous revision: the first field that moved, or that none did. */
export function cellDelta(c: MatrixCell): string | null {
  const d = c.row?.delta
  if (!d || d.change_type !== 'modified') return null
  const [move] = priceMoves(d)
  if (!move) return SAME_PRICE
  return move.pct === null ? moveText(move) : `${pctLabel(move.pct)} ${move.side}`
}
