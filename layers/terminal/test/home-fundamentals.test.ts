import { describe, expect, it } from 'vitest'

import {
  gpuFigure,
  listedFigure,
  thesisFigure,
  truthFigure,
  utilizationFigure,
} from '../app/utils/home-fundamentals'
import type { ListedData } from '../shared/utils/listed'
import type { UtilizationData } from '#layers/compute/shared/utils/compute-views'
import type { GpuPricesData } from '../../compute/shared/types/gpu-prices'
import type { GroundTruthData } from '../../press/shared/types/ground-truth'
import type { ThesesData } from '../../theses/shared/utils/thesis-types'

const AT = '2026-11-19T12:00:00.000Z'
const src = (host: string, fetched_at = AT) => ({ source_url: `https://${host}/`, fetched_at })

describe('home fundamentals', () => {
  it('scores the press against the newest filing, or states the gap', () => {
    const tally = { periods: 3, reports: 35, median_abs_error_pct: 0.92 }
    const truth = {
      tally,
      resolutions: [{ lab: 'anthropic', filed: { ...src('www.sec.gov'), form: 'S-1/A' } }],
    } as unknown as GroundTruthData
    const f = truthFigure(truth)
    expect(f.value).toBe('0.9%')
    expect(f.sub).toBe('Median error of 35 reports against 3 filed figures')
    expect(f.source).toEqual({ ...src('www.sec.gov'), label: 'Anthropic S-1/A' })

    const none = truthFigure({
      tally: { ...tally, reports: 0, median_abs_error_pct: null },
      resolutions: [],
    } as unknown as GroundTruthData)
    expect(none.value).toBeNull()
    expect(none.gap?.title).toBe('No report scored yet')
  })

  it('counts the listed companies tied to a lab', () => {
    const listed = { counts: { companies: 45, lab_tied: 26 } } as unknown as ListedData
    expect(listedFigure(listed).value).toBe('26')
    expect(listedFigure(listed).sub).toBe('Tied to a lab by a filing or a site, of 45 we list')
  })

  it('cites the newest provider page behind the H100 median', () => {
    const gpu = {
      medians: [
        {
          gpu: 'H100',
          median: 4.74,
          providers: [src('a.example', '2026-11-19T10:00:00Z'), src('b.example')],
        },
      ],
    } as unknown as GpuPricesData
    const f = gpuFigure(gpu)
    expect(f.value).toBe('$4.74')
    expect(f.source?.source_url).toBe('https://b.example/')
  })

  it('reads the first utilization figure /compute shows', () => {
    const base = {
      spot: {
        providers: [{ ...src('coreweave.com'), gpu: 'H100' }],
        providers_needed: 4,
        combined: [{ gpu: 'H100', providers: 1, ratio: null }],
      },
      implied: null,
      coreweave: null,
      demand_shape: { ratio: 0.56, days: 30, source: src('openrouter.ai') },
    } as unknown as UtilizationData
    // The demand shape is drawn inside the implied-load panel, so it needs that panel.
    expect(utilizationFigure(base).gap?.reason).toBe(
      '1 of the 4 providers we need print a spot price.',
    )
    const implied = { ...base, implied: {} } as unknown as UtilizationData
    expect(utilizationFigure(implied).value).toBe('56%')
    expect(utilizationFigure(implied).to).toBe('/compute#implied-load')

    const spot = {
      ...implied,
      spot: {
        ...base.spot,
        combined: [{ gpu: 'H100', providers: 4, ratio: { low: 0.4, high: 0.42 } }],
      },
    } as unknown as UtilizationData
    expect(utilizationFigure(spot).value).toBe('40%–42%')
    expect(utilizationFigure(spot).source?.source_url).toBe('https://coreweave.com/')
  })

  it('picks the claim whose status changed last', () => {
    const claim = (n: number, status_since: string | null, extra = {}) => ({
      n,
      status: 'holding',
      status_since,
      latest: src('ramp.com'),
      verdicts: [],
      ...extra,
    })
    const theses = {
      theses: [
        { id: 'compute', title: 'Compute', claims: [claim(1, '2026-11-05T00:00:00Z')] },
        {
          id: 'anthropic',
          title: 'Anthropic',
          claims: [
            claim(4, null),
            claim(5, '2026-11-13T18:23:18Z', {
              status: 'weakening',
              latest: null,
              verdicts: [src('status.anthropic.com')],
            }),
          ],
        },
      ],
    } as unknown as ThesesData
    const f = thesisFigure(theses)
    expect(f.value).toBe('Weakening')
    expect(f.to).toBe('/theses/anthropic#claim-5')
    expect(f.sub).toBe('Anthropic thesis, claim 5, since Nov 13')
    expect(f.source?.source_url).toBe('https://status.anthropic.com/')
  })
})
