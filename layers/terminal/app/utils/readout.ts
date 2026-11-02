// One lab's reading on each axis, as the cells the readout shows: the
// figure, its delta, a sub-line, where it links, its source, or the stated gap.
// The front page draws these as a table row per lab and the lab page as a row
// of figures; deriving both from here is what keeps the two from disagreeing.

import {
  compactUsd,
  count,
  money,
  periodLabel,
  ppLabel,
  sharePct,
  signed,
} from '../../shared/utils/terminal-format'
import { labPath, type LabSummary } from '../../shared/utils/terminal-lab-summary'
import type { Prov } from '../../shared/utils/terminal-types'
import type { GapRef } from '../types/terminal-ui'

import { feedGap } from './feed-gap'

export const READOUT_AXES = ['prices', 'revenue', 'demand', 'hiring', 'incidents'] as const
export type ReadoutAxis = (typeof READOUT_AXES)[number]

export interface ReadoutCell {
  label: string
  value: string | null
  delta: string | null
  sub: string | null
  /** The lab page section that carries this figure in full. */
  to: string
  source: Prov | null
  gap: GapRef | null
}

export const READOUT_LABEL: Record<ReadoutAxis, string> = {
  prices: 'Flagship $/Mtok',
  revenue: 'SEC revenue',
  demand: 'Demand share',
  hiring: 'Open roles',
  incidents: 'Incidents 30d',
}

export function readoutCells(
  s: LabSummary,
  rankingsSource: Prov | null | undefined,
): Record<ReadoutAxis, ReadoutCell> {
  const at = (id: string) => `${labPath(s.lab)}#${id}`
  const cell = (axis: ReadoutAxis, id: string, c: Partial<ReadoutCell>): ReadoutCell => ({
    label: READOUT_LABEL[axis],
    value: null,
    delta: null,
    sub: null,
    to: at(id),
    source: null,
    gap: null,
    ...c,
  })

  const f = s.flagship
  const prices = f?.priced
    ? cell('prices', 'prices', {
        value: `${money(f.row!.input_per_mtok)} / ${money(f.row!.output_per_mtok)}`,
        sub: `in / out · ${f.row!.model_slug}`,
        source: f.row,
      })
    : cell('prices', 'prices', {
        gap: {
          title: f?.row ? 'No published price' : 'Not mapped',
          reason: f?.gap ?? undefined,
          name: `Why ${s.display} has no flagship price`,
        },
      })

  const r = s.revenue
  const revenue = r.newest
    ? cell('revenue', 'revenue', {
        value: compactUsd(r.newest.val),
        sub: `${periodLabel(r.newest.days)} to ${r.newest.end}${r.view?.disclosure === 'parent' ? ' · parent' : ''}`,
        source: r.newest,
      })
    : cell('revenue', 'revenue', {
        gap:
          r.view?.disclosure === 'no_rows'
            ? {
                title: 'Not parsed yet',
                reason:
                  r.view.filer?.relation === 'issuer'
                    ? 'S-1 filed; no revenue read yet.'
                    : 'Filer tagged; no XBRL facts parsed yet.',
              }
            : {
                title: 'None filed',
                reason:
                  'No SEC filing reports this lab’s revenue. Press-reported run-rates are excluded.',
                name: `Why ${s.display} has no SEC revenue`,
              },
      })

  const d = s.demand
  const demand =
    d && d.share !== null
      ? cell('demand', 'demand', {
          value: sharePct(d.share),
          delta: d.delta_pp === null ? null : ppLabel(d.delta_pp),
          sub: 'OpenRouter, 7 days',
          source: rankingsSource ?? null,
        })
      : cell('demand', 'demand', { gap: { title: 'No rankings rows yet' } })

  const h = s.hiring
  const hiring =
    h.now !== null
      ? cell('hiring', 'hiring', {
          value: count(h.now),
          delta: h.delta === null ? null : `${signed(h.delta)} in ${h.days}d`,
          sub: h.cluster ? `${count(h.cluster.now)} ${h.cluster.label.toLowerCase()}` : null,
          source: h.view?.sources[0] ?? null,
        })
      : cell('hiring', 'hiring', {
          gap: (h.view && feedGap('hiring', h.view)) ?? { title: 'No parsed roles yet' },
        })

  const i = s.incidents
  const incidents =
    i?.feed === 'ok'
      ? cell('incidents', 'incidents', {
          value: String(i.last_window),
          delta: `vs ${i.prior_window}`,
          sub: i.open.length ? `${i.open.length} open now` : 'none open',
          source: i.sources[0] ?? null,
        })
      : cell('incidents', 'incidents', {
          gap: (i && feedGap('incidents', i)) ?? { title: 'No parsed incidents yet' },
        })

  return { prices, revenue, demand, hiring, incidents }
}
