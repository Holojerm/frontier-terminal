// Each wave as its own family: the registered cells only, so a horizon or a
// ticker nobody predicted can't join after the fact and widen the family.

import {
  signalFamilyCellHolds,
  type SignalFamilyCell,
  type SignalFamilyView,
  type SignalSeriesView,
} from '../../shared/utils/signals'
import { SIGNAL_WAVES, type SignalWave } from './waves'

export function familyViews(
  series: readonly SignalSeriesView[],
  allTestsP: number | null,
  waves: readonly SignalWave[] = SIGNAL_WAVES,
): SignalFamilyView[] {
  const byId = new Map(series.map((s) => [s.id, s]))
  return waves.map((wave) => {
    const cells: SignalFamilyCell[] = wave.hypotheses.flatMap((h) =>
      h.tickers.flatMap((ticker) =>
        h.horizons.map((horizon) => ({
          series: h.series,
          ticker,
          horizon,
          direction: h.direction,
          cell:
            byId.get(h.series)?.cells.find((c) => c.ticker === ticker && c.horizon === horizon) ??
            null,
        })),
      ),
    )
    const tests = cells.reduce(
      (n, c) => n + (c.cell?.in.status === 'ok' ? 1 : 0) + (c.cell?.out.status === 'ok' ? 1 : 0),
      0,
    )
    const bar = tests > 0 ? 0.05 / tests : null
    const holding = cells.filter((c) => signalFamilyCellHolds(c, bar))
    return {
      id: wave.id,
      label: wave.label,
      registered: wave.registered,
      doc: wave.doc,
      tests,
      bonferroni_p: bar,
      holds: holding.length,
      holds_all: holding.filter((c) => signalFamilyCellHolds(c, allTestsP)).length,
      cells,
    }
  })
}
