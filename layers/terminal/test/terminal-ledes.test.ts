import { describe, expect, it } from 'vitest'

import { labLede, longDate, skuLede } from '../shared/utils/terminal-ledes'
import type { LabSummary } from '../shared/utils/terminal-lab-summary'
import type { PriceHistoryData, PricePoint } from '../shared/utils/terminal-types'

const PROV = {
  source_url: 'https://platform.claude.com/pricing',
  fetched_at: '2026-09-22T18:01:00Z',
}

function point(
  kind: PricePoint['kind'],
  at: string,
  input: number | null,
  output: number | null,
): PricePoint {
  return {
    ...PROV,
    at,
    kind,
    basis: kind === 'archived' ? 'archived' : 'live',
    source_id: 'anthropic-pricing',
    input_per_mtok: input,
    cached_input_per_mtok: null,
    output_per_mtok: output,
    diff: [],
  }
}

function history(points: PricePoint[], extra: Partial<PriceHistoryData> = {}): PriceHistoryData {
  return {
    provider: 'anthropic',
    model_slug: 'claude-fable-5-1',
    tier: null,
    removed: false,
    points,
    ...extra,
  } as PriceHistoryData
}

describe('longDate', () => {
  it('always carries the year, in UTC', () => {
    expect(longDate('2026-09-22T23:59:00Z')).toBe('Sep 22, 2026')
    expect(longDate('nope')).toBe('nope')
  })
})

describe('skuLede', () => {
  it('dates the price from the first observation of the current run', () => {
    const h = history([
      point('baseline', '2026-09-02T00:35:00Z', 15, 75),
      point('modified', '2026-09-08T06:00:00Z', 10, 50),
      point('current', '2026-11-01T00:00:00Z', 10, 50),
    ])
    expect(skuLede(h)).toBe(
      'Anthropic lists claude-fable-5-1 at $10.00 per million input tokens and $50.00 per million output tokens. That price has held since Sep 8, 2026.',
    )
  })

  it('only bounds the date from below when the run starts at our first check', () => {
    const h = history([point('baseline', '2026-09-02T00:35:00Z', null, 50)], { tier: 'batch' })
    expect(skuLede(h)).toBe(
      'Anthropic lists claude-fable-5-1 (batch) at $50.00 per million output tokens. That price has held since at least Sep 2, 2026.',
    )
  })

  it('does not date a price from a lone current point', () => {
    const h = history([point('current', '2026-10-12T18:11:00Z', 10, 50)])
    expect(skuLede(h)).toContain('since at least Oct 12, 2026.')
  })

  it('says delisted, with the last listed price', () => {
    const h = history(
      [
        point('added', '2026-09-02T00:35:00Z', 1, 5),
        point('removed', '2026-10-01T00:00:00Z', null, null),
      ],
      { removed: true },
    )
    expect(skuLede(h)).toBe(
      'Anthropic delisted claude-fable-5-1 on Oct 1, 2026. Its last listed price was $1.00 per million input tokens and $5.00 per million output tokens.',
    )
  })

  it('has nothing to say without a published price', () => {
    expect(skuLede(history([point('baseline', '2026-09-02T00:35:00Z', null, null)]))).toBeNull()
  })
})

describe('labLede', () => {
  const base: LabSummary = {
    lab: 'anthropic',
    display: 'Anthropic',
    flagship: null,
    revenue: { view: null, newest: null },
    demand: null,
    spend: null,
    hiring: { view: null, now: null, delta: null, days: null, cluster: null },
    incidents: null,
    alerts: [],
  }

  it('is null when there is nothing to state', () => {
    expect(labLede(base)).toBeNull()
  })

  it('names the lab once, then uses "It"', () => {
    const s = {
      ...base,
      flagship: {
        priced: true,
        row: { model_slug: 'claude-opus-5-5', input_per_mtok: 4, output_per_mtok: 20 },
      },
      revenue: {
        view: { disclosure: 'issuer' },
        newest: { val: 33_200_000_000, days: 272, end: '2026-09-30', form: 'S-1/A' },
      },
      demand: { share: 0.062 },
      hiring: { ...base.hiring, now: 681 },
    } as unknown as LabSummary
    expect(labLede(s)).toBe(
      'Anthropic’s flagship API model is claude-opus-5-5, at $4.00 per million input tokens and $20.00 per million output tokens. It reported $33.2B in revenue for the nine months ending 2026-09-30 (S-1/A filed with the SEC). It had 6.2% of all OpenRouter tokens over the last 7 days. It lists 681 open roles.',
    )
  })

  it('leaves out a parent company’s revenue and starts with the lab name', () => {
    const s = {
      ...base,
      display: 'Google',
      revenue: {
        view: { disclosure: 'parent' },
        newest: { val: 1e11, days: 91, end: '2026-09-30', form: '10-Q' },
      },
      hiring: { ...base.hiring, now: 1 },
    } as unknown as LabSummary
    expect(labLede(s)).toBe('Google lists 1 open role.')
  })
})
