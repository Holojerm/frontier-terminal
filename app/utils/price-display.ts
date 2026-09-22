// How a like-for-like cell reads: the vendor sentence behind the mapping,
// and the move since the previous revision. Shared by the matrix and the
// front page's flagship grid so one cell never explains itself two ways.

import { absoluteStamp, pctChange, pctLabel } from '#shared/utils/terminal-format'
import type { MatrixCell } from '#shared/utils/terminal-types'

/** The vendor sentence behind a cell, and the last poll's word on whether it is still there. */
export function basisText(c: MatrixCell, label: string): string {
  const mapped = `Mapped to “${label}” on the vendor's own words: “${c.basis}” (${c.basis_source_id}).`
  if (c.basis_current === false) return `${mapped} ${c.basis_note ?? ''}`.trim()
  if (c.basis_current === true && c.basis_checked_at) {
    return `${mapped} Sentence confirmed on the page at the ${absoluteStamp(c.basis_checked_at)} poll.`
  }
  return mapped
}

/** Percent move on the input price since the previous revision, when there is one. */
export function cellDelta(c: MatrixCell): string | null {
  const d = c.row?.delta
  if (!d || d.change_type !== 'modified') return null
  const pct = pctChange(d.input_before, d.input_after)
  return pct === null ? null : `${pctLabel(pct)} in`
}
