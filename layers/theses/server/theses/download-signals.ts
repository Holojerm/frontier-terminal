// The npm-normalized-trailing-sum signal: a claim's readings off the adoption
// layer's normalized download series (layers/adoption/server/recipes/download-series.ts).

import type { SignalSpec } from '../../shared/utils/thesis-types'
import type { PipelineDb } from '#layers/core/server/utils/pipeline-store'
import { readDownloadSeries, trailingRatio } from '#layers/adoption/server/recipes/download-series'
import type { SignalReading } from './signals'

/**
 * A claim's readings: the package's downloads over the trailing `days` ÷
 * the control index, on every day at least three quarters of the window is
 * on record. The raw sum and the days it rests on go in the detail.
 */
export async function readNormalizedTrailing(
  db: PipelineDb,
  spec: Extract<SignalSpec, { signal: 'npm-normalized-trailing-sum' }>,
): Promise<SignalReading[]> {
  const series = await readDownloadSeries(db)
  const raw = (series.rows.get(spec.recipe) ?? []).filter((r) => !r.outage)
  return trailingRatio(raw, series.index, spec.days, Math.ceil((spec.days * 3) / 4)).map((p) => ({
    date: p.date,
    value: p.value,
    detail: {
      days: spec.days,
      downloads: p.num,
      control_index: p.den,
      days_on_record: p.days,
      compare: null,
    },
    source_url: p.source_url,
    fetched_at: p.fetched_at,
  }))
}
