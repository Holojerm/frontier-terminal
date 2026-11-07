import { describe, expect, it } from 'vitest'

import {
  buildTearSheet,
  exposurePeriod,
  exposureValue,
  priceChangeLabel,
  shortStamp,
  shortUrl,
  SHEET_ALERTS,
} from '../app/utils/tear-sheet'
import { cellDelta, priceCitation } from '../app/utils/price-display'
import { PROVIDER_ORDER } from '../server/utils/terminal-sources'
import type { ExposureData } from '../shared/utils/terminal-exposure'
import { LABS, TEAR_SHEET_PAGES } from '../shared/utils/terminal-lab-summary'
import type {
  AlertView,
  MatrixCell,
  PriceDeltaView,
  PriceRowView,
  PricesData,
  RankingsData,
  RevenueData,
} from '../shared/utils/terminal-types'

const AT = '2026-11-04T18:00:03.511Z'

const delta = (d: Partial<PriceDeltaView>): PriceDeltaView => ({
  change_type: 'modified',
  detected_at: '2026-10-07T22:00:17.461Z',
  input_before: null,
  input_after: null,
  output_before: null,
  output_after: null,
  cached_before: null,
  cached_after: null,
  source_url: 'https://example.com/pricing',
  fetched_at: AT,
  ...d,
})

describe('shortUrl', () => {
  it('drops the scheme, www and query, and keeps a short path whole', () => {
    expect(shortUrl('https://www.anthropic.com/pricing?x=1')).toBe('anthropic.com/pricing')
  })
  it('cuts a long path to the host and its last segment', () => {
    expect(
      shortUrl(
        'https://www.sec.gov/Archives/edgar/data/789019/000119312526436133/msft-20260930_htm.xml',
      ),
    ).toBe('sec.gov/…/msft-20260930_htm.xml')
  })
  it('clips to the limit, and passes an unparseable string through clipped', () => {
    expect(shortUrl('https://example.com/a/very-long-final-segment-name', 20)).toBe(
      'example.com/…/very-…',
    )
    expect(shortUrl('not a url', 40)).toBe('not a url')
  })
})

describe('shortStamp', () => {
  it('prints the UTC minute with the year, never a relative age', () => {
    expect(shortStamp(AT)).toBe('2026-11-04 18:00Z')
    expect(shortStamp('2026-01-02T03:04:05+02:00')).toBe('2026-01-02 01:04Z')
  })
  it('passes an unparseable stamp through', () => {
    expect(shortStamp('soon')).toBe('soon')
  })
})

describe('priceChangeLabel', () => {
  it('says when nothing has changed since tracking began', () => {
    expect(priceChangeLabel(null)).toBe('None on record')
  })
  it('dates a listing and a delisting', () => {
    expect(priceChangeLabel(delta({ change_type: 'added' }))).toBe('Listed 2026-10-07')
    expect(priceChangeLabel(delta({ change_type: 'removed' }))).toBe('Delisted 2026-10-07')
  })
  it('prints each side that moved, with its percent', () => {
    expect(
      priceChangeLabel(
        delta({ input_before: 3, input_after: 2, output_before: 15, output_after: 10 }),
      ),
    ).toBe('In $3.00 → $2.00 (−33.3%), out $15.00 → $10.00 (−33.3%) on 2026-10-07')
    expect(priceChangeLabel(delta({ output_before: 10, output_after: 12 }))).toBe(
      'Out $10.00 → $12.00 (+20%) on 2026-10-07',
    )
  })
  it('says the price held when the edit was elsewhere on the row', () => {
    expect(
      priceChangeLabel(
        delta({ input_before: 2, input_after: 2, output_before: 10, output_after: 10 }),
      ),
    ).toBe('Edited 2026-10-07, same price')
  })
  it('names a cached-input move rather than calling the price unchanged', () => {
    expect(priceChangeLabel(delta({ cached_before: 0.5, cached_after: 0.25 }))).toBe(
      'Cached $0.50 → $0.25 (−50%) on 2026-10-07',
    )
  })
})

describe('cellDelta', () => {
  const moved = (d: Partial<PriceDeltaView>) =>
    cellDelta(cell({ priced: true, row: row({ delta: delta(d) }) }))
  it('reads the field that moved, never a held input as 0%', () => {
    expect(moved({ input_before: 2, input_after: 2, output_before: 10, output_after: 8 })).toBe(
      '−20% out',
    )
    expect(moved({ input_before: 3, input_after: 2, output_before: 15, output_after: 10 })).toBe(
      '−33.3% in',
    )
    expect(moved({ input_before: 1, input_after: 1, cached_before: 0.1, cached_after: 0.2 })).toBe(
      '+100% cached',
    )
  })
  it('says the price held when no price field moved', () => {
    expect(moved({ input_before: 2, input_after: 2, output_before: 10, output_after: 10 })).toBe(
      'same price',
    )
  })
  it('prints both sides when there is no base for a percent', () => {
    expect(moved({ output_before: null, output_after: 8 })).toBe('out — → $8.00')
  })
  it('says nothing for a listing or a row with no change', () => {
    expect(moved({ change_type: 'added' })).toBeNull()
    expect(cellDelta(cell({ row: row({}) }))).toBeNull()
  })
})

describe('exposure formatting', () => {
  it('reads dollars, a stake and a share count as filed', () => {
    expect(exposureValue({ unit: 'USD' }, 13_000_000_000)).toBe('$13.0B')
    expect(exposureValue({ unit: 'pure' }, 0.27)).toBe('27%')
    expect(exposureValue({ unit: 'shares' }, 164_000_000)).toBe('164,000,000 shares')
  })
  it('names a balance date, a quarter and a longer flow', () => {
    expect(exposurePeriod({ months: null, end: '2026-09-30' })).toBe('at 2026-09-30')
    expect(exposurePeriod({ months: 3, end: '2026-09-30' })).toBe('quarter to 2026-09-30')
    expect(exposurePeriod({ months: 9, end: '2026-09-30' })).toBe('9 months to 2026-09-30')
  })
})

// ---- the sheet -------------------------------------------------------------

const row = (over: Partial<PriceRowView>): PriceRowView => ({
  entity_key: 'model:x',
  source_id: 'anthropic-pricing',
  provider: 'anthropic',
  model_slug: 'claude-opus-5-5',
  tier: null,
  context_window: null,
  context_window_source: null,
  input_per_mtok: 4,
  cached_input_per_mtok: null,
  output_per_mtok: 20,
  effective_from: null,
  effective_until: null,
  notes: null,
  removed: false,
  delta: null,
  also_listed_by: [],
  revisions: 1,
  spark: null,
  source_url: 'https://platform.claude.com/docs/en/about-claude/pricing.md',
  fetched_at: AT,
  checked_at: null,
  ...over,
})

const cell = (over: Partial<MatrixCell>): MatrixCell => ({
  provider: 'anthropic',
  class: 'flagship',
  row: null,
  basis: null,
  basis_source_id: null,
  basis_current: null,
  basis_checked_at: null,
  basis_note: null,
  gap: null,
  priced: false,
  ...over,
})

const prices: Pick<PricesData, 'matrix'> = {
  matrix: {
    classes: [
      { id: 'flagship', label: 'Flagship', question: '' },
      { id: 'balanced', label: 'Balanced', question: '' },
      { id: 'economy', label: 'Economy', question: '' },
    ],
    providers: ['anthropic'],
    tier_note: 'Standard tier.',
    cells: [
      cell({ class: 'flagship', priced: true, row: row({}) }),
      cell({
        class: 'balanced',
        priced: true,
        row: row({ model_slug: 'claude-sonnet-5-5', input_per_mtok: 2, output_per_mtok: 10 }),
      }),
      cell({ class: 'economy', gap: 'The page names no economy model.' }),
    ],
  },
}

const revenue: RevenueData = {
  as_of: AT,
  computed_at: AT,
  rule: '',
  providers: [
    {
      provider: 'google',
      display: 'Google',
      disclosure: 'parent',
      filer: {
        ticker: 'GOOGL',
        cik: '0001652044',
        entity_name: 'Alphabet Inc.',
        relation: 'parent',
        segment: 'goog:GoogleCloudMember',
        segment_label: 'Google Cloud',
        tagged_by: 'sources.yaml',
        resolved_from: null,
        source_id: 'sec-googl',
        caveat: null,
      },
      periods: [
        {
          entity_key: 'rev:q3',
          start: '2026-07-01',
          end: '2026-09-30',
          days: 92,
          fy: 2026,
          fp: 'Q3',
          form: '10-Q',
          filed: '2026-10-29',
          accession_no: '0001652044-26-000084',
          filing_url: 'https://www.sec.gov/Archives/edgar/data/1652044/000165204426000084/',
          tag: 'Revenues',
          val: 30_709_000_000,
          frame: null,
          basis: 'xbrl',
          unaudited: false,
          source_url:
            'https://www.sec.gov/Archives/edgar/data/1652044/000165204426000084/goog-20260930_htm.xml',
          fetched_at: AT,
        },
      ],
      superseded: [],
      tags: [],
      sources: [],
    },
  ],
}

const rankings = {
  provenance: {
    source_url: 'https://openrouter.ai/api/v1/datasets/rankings-daily',
    fetched_at: AT,
  },
  meta: {
    as_of: AT,
    citation: 'Source: OpenRouter (openrouter.ai/rankings). Licensed under CC BY 4.0.',
    coverage: {
      days: 14,
      first_date: '2026-10-21',
      last_date: '2026-11-03',
      window: { from: '2026-10-28', to: '2026-11-03' },
      prior_window: null,
    },
  },
  shares: [
    {
      provider: 'anthropic',
      display: 'Anthropic',
      tokens: 1,
      share: 0.0624,
      prior_tokens: 1,
      prior_share: 0.0765,
      delta_pp: -1.41,
    },
  ],
} as unknown as RankingsData

const exposure: Pick<ExposureData, 'series' | 'gaps' | 'filers'> = {
  filers: [],
  gaps: [
    { id: 'googl-anthropic', group: 'anthropic', ticker: 'GOOGL', title: 'Not filed', reason: 'r' },
    { id: 'meta-rpo', group: 'rpo', ticker: 'META', title: 'No backlog', reason: 'r' },
  ],
  series: [
    {
      id: 'amzn-anthropic-shares',
      ticker: 'AMZN',
      filer: 'Amazon',
      group: 'anthropic',
      chart: 'x',
      label: 'Anthropic shares held',
      concept: '',
      dims: '',
      kind: 'balance',
      unit: 'shares',
      note: null,
      superseded: [],
      points: [
        {
          start: null,
          end: '2026-09-30',
          value: 164_000_000,
          derived: false,
          less: null,
          months: null,
          accession_no: '0001018724-26-000040',
          form: '10-Q',
          filed: '2026-10-30',
          filing_url: 'https://www.sec.gov/Archives/edgar/data/1018724/000101872426000040/',
          source_url:
            'https://www.sec.gov/Archives/edgar/data/1018724/000101872426000040/amzn-20260930_htm.xml',
          fetched_at: AT,
        },
      ],
    },
    {
      id: 'msft-capex',
      ticker: 'MSFT',
      filer: 'Microsoft',
      group: 'capex',
      chart: 'x',
      label: 'Capex',
      concept: '',
      dims: '',
      kind: 'flow',
      unit: 'USD',
      note: null,
      superseded: [],
      points: [],
    },
  ],
}

const alert = (i: number, severity: AlertView['severity'], url: string): AlertView => ({
  id: String(i).padStart(64, '0'),
  severity,
  headline: `Alert ${i}`,
  explanation: '',
  rule: 'agent-judge',
  created_at: `2026-11-0${9 - i}T00:00:00Z`,
  change_ids: [],
  changes: [
    {
      id: `c${i}`,
      entity_key: 'k',
      entity_type: 'model',
      provider: 'anthropic',
      change_type: 'added',
      detected_at: AT,
      summary: '',
      diff: [],
      source_url: url,
      fetched_at: AT,
    },
  ],
  missing_change_ids: [],
  source_url: url,
  fetched_at: AT,
})

describe('buildTearSheet', () => {
  const sheet = buildTearSheet('anthropic', {
    prices,
    rankings,
    exposure,
    alerts: [
      alert(1, 'critical', 'https://platform.claude.com/docs/en/about-claude/pricing.md'),
      alert(2, 'info', 'https://example.com/info'),
      ...[3, 4, 5, 6, 7, 8].map((i) => alert(i, 'notable', `https://example.com/${i}`)),
    ],
  })

  it('prices each class and states the gap where a class has no price', () => {
    expect(sheet.prices.map((p) => [p.label, p.input, p.output, p.gap?.title ?? null])).toEqual([
      ['Flagship', '$4.00', '$20.00', null],
      ['Balanced', '$2.00', '$10.00', null],
      ['Economy', '', '', 'Not mapped'],
    ])
    expect(sheet.prices[2]!.gap!.reason).toBe('The page names no economy model.')
  })

  it('cites a price to its newest read, not to when it last changed', () => {
    const read = '2026-11-07T12:00:00.000Z'
    expect(priceCitation(row({ checked_at: read }))).toEqual({
      source_url: 'https://platform.claude.com/docs/en/about-claude/pricing.md',
      fetched_at: read,
    })
    expect(priceCitation(row({})).fetched_at).toBe(AT)
  })

  it('numbers each source once, in the order the sheet cites it', () => {
    expect(sheet.prices[0]!.ref).toBe(1)
    expect(sheet.prices[1]!.ref).toBe(1)
    expect(sheet.exposure.lines[0]!.ref).toBe(2)
    expect(sheet.demand.ref).toBe(3)
    // The first alert read the pricing page, already source 1.
    expect(sheet.alerts[0]!.ref).toBe(1)
    expect(sheet.sources.map((s) => s.n)).toEqual(sheet.sources.map((_, i) => i + 1))
    expect(new Set(sheet.sources.map((s) => s.url)).size).toBe(sheet.sources.length)
  })

  it('keeps only the hyperscaler lines and gaps that name this lab', () => {
    expect(sheet.exposure.lines).toEqual([
      expect.objectContaining({
        label: 'Amazon: Anthropic shares held',
        period: 'at 2026-09-30',
        value: '164,000,000 shares',
      }),
    ])
    expect(sheet.exposure.gaps.map((g) => g.title)).toEqual(['Not filed'])
  })

  it('labels the demand share’s denominator and carries the upstream citation', () => {
    expect(sheet.demand.label).toBe('OpenRouter share of all tokens')
    expect(sheet.demand.value).toBe('6.2%')
    expect(sheet.demand.delta).toBe('−1.4 pp on 7 days before')
    expect(sheet.citations).toEqual([rankings.meta.citation])
  })

  it('lists the newest notable or critical alerts, never a minor change', () => {
    expect(sheet.alerts).toHaveLength(SHEET_ALERTS)
    expect(sheet.alerts.map((a) => a.severity)).not.toContain('info')
    expect(sheet.alerts[0]).toMatchObject({ date: '2026-11-08', severity: 'critical' })
  })

  it('states every missing axis instead of printing a zero', () => {
    expect(sheet.revenue.gap?.title).toBe('None filed')
    expect(sheet.hiring.value).toBeNull()
    expect(sheet.hiring.gap?.title).toBe('No parsed roles yet')
    expect(sheet.incidents.value).toBeNull()
    expect(sheet.thesis).toBeNull()
  })

  it('names a parent’s segment as the parent’s figure', () => {
    const google = buildTearSheet('google', { revenue })
    expect(google.revenue.scope).toBe(
      'Google Cloud segment, as Alphabet Inc. (GOOGL) reports it. It’s the parent’s figure.',
    )
    expect(google.revenue.lines).toEqual([
      expect.objectContaining({ period: 'quarter to 2026-09-30', value: '$30.7B', ref: 1 }),
    ])
    expect(google.sources[0]!.label).toBe('10-Q filed 2026-10-29')
  })

  it('builds for a lab with no data at all', () => {
    const empty = buildTearSheet('mistral', {})
    expect(empty.prices).toEqual([])
    expect(empty.sources).toEqual([])
    expect(empty.demand.gap?.title).toBe('No rankings data yet')
  })
})

describe('tear sheet pages', () => {
  it('gives every tracked lab a sheet, so a new lab gets one with no other change', () => {
    expect(LABS).toEqual([...PROVIDER_ORDER])
    expect(TEAR_SHEET_PAGES.map((p) => p.path)).toEqual(
      PROVIDER_ORDER.map((lab) => `/labs/${lab}/tear-sheet`),
    )
  })
})
