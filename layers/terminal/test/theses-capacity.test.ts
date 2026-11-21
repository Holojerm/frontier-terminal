import { describe, expect, it } from 'vitest'

import azure from '~~/fixtures/recipes/gpu-azure.json?raw'
import coreweave from '~~/fixtures/recipes/gpu-coreweave.html?raw'

import type { RevenuePeriod } from '../shared/utils/terminal-types'
import { detailRows, earlyReadLines, earlyReadSummary } from '../shared/utils/thesis-format'
import type { StoredFact } from '../../companies/server/exposure/series'
import {
  guidanceShortfalls,
  peakThroughputReadings,
  spotToOnDemand,
} from '../server/theses/capacity-signals'
import { COMPUTE_THESIS } from '../server/theses/compute'
import type { GpuObservation } from '#layers/compute/server/recipes/gpu-series'
import { gpuPricePayload } from '#layers/compute/server/recipes/gpu-prices'
import { RECIPES } from '#server/registries/recipes'
import { presentation } from '../server/theses/signals'
import { evaluateClaim, type MeasuredClaim, type StoredReading } from '../server/theses/status'
import { pressEarlyRead } from '../../press/server/utils/terminal-ground-truth'
import type { StoredGuidance } from '../../companies/server/utils/terminal-ground-truth-guidance'
import type { StoredHeadline } from '../../press/server/utils/terminal-reported'

// The Compute thesis's capacity claims (7 to 9) and the press early read
// beside Anthropic's revenue claim. Tables of our own, except the spot prices,
// which are read from the two captured pages that print one.

const claim = (id: string) => COMPUTE_THESIS.claims.find((c) => c.id === id) as MeasuredClaim
const evaluate = (id: string, readings: StoredReading[]) =>
  evaluateClaim(claim(id), readings, presentation(claim(id)).fmt)
const reading = (date: string, value: number, void_reason?: string): StoredReading => ({
  date,
  value,
  compare: null,
  void_reason,
})
const weekly = (values: number[], newest = '2026-12-28') =>
  values.map((v, i) =>
    reading(
      new Date(Date.parse(newest) - (values.length - 1 - i) * 7 * 86_400_000)
        .toISOString()
        .slice(0, 10),
      v,
    ),
  )

describe('claim 7: spot against on-demand', () => {
  const obs = (
    provider: string,
    value: number,
    spot_low: number | null,
    spot_high: number | null,
    gpu: 'H100' | 'B200' = 'H100',
  ): GpuObservation => ({
    provider,
    gpu,
    counted: true,
    value,
    spot_low,
    spot_high,
    source_url: `https://${provider}.test/pricing`,
    fetched_at: '2026-11-20T00:01:00.000Z',
  })

  it('takes the middle of each provider’s spot range over its on-demand price, then the median', () => {
    const read = spotToOnDemand('H100', [
      obs('coreweave', 6, 2.4, 3.6),
      obs('microsoft', 10, 4, 4),
      obs('lambda', 4, 3.2, 3.2),
      obs('nebius', 3, null, null),
      obs('crusoe', 5, 1, 1, 'B200'),
    ])!
    expect(Object.keys(read.providers).sort()).toEqual(['coreweave', 'lambda', 'microsoft'])
    expect(read.providers.coreweave).toMatchObject({ on_demand: 6, spot_low: 2.4, ratio: 0.5 })
    expect(read.value).toBe(0.5)
  })

  it('has no reading when no page prints a spot price', () => {
    expect(spotToOnDemand('H100', [obs('nebius', 3, null, null)])).toBeNull()
  })

  it('finds an H100 spot price on two captured pages, CoreWeave’s and Azure’s, and a B200 one on CoreWeave’s', () => {
    const observations = (id: string, body: string) =>
      RECIPES.find((r) => r.id === id)!
        .extract(body, { date: '2026-11-20' })
        .map((o): GpuObservation => {
          const p = gpuPricePayload.parse(o.payload)
          return {
            provider: p.provider,
            gpu: p.gpu,
            counted: p.counted,
            value: o.value!,
            spot_low: p.spot_low_usd_per_gpu_hour,
            spot_high: p.spot_high_usd_per_gpu_hour,
            source_url: 'https://example.test',
            fetched_at: '2026-11-20T00:01:00.000Z',
          }
        })
    const all = [...observations('gpu-coreweave', coreweave), ...observations('gpu-azure', azure)]
    const providers = (gpu: 'H100' | 'B200') =>
      Object.keys(spotToOnDemand(gpu, all)?.providers ?? {}).sort()
    expect(providers('H100')).toEqual(['coreweave', 'microsoft'])
    expect(providers('B200')).toEqual(['coreweave'])
  })

  it('breaks once the share sits 30% below its 90-day high for 4 straight weekly readings', () => {
    // 18 weekly readings: the 111 days the rule needs, and a high of 40%.
    const after = (tail: number[]) =>
      evaluate('compute-gpu-spot-tight', weekly([...Array<number>(14).fill(0.4), ...tail]))
    expect(after([0.4, 0.4, 0.4, 0.38]).status).toBe('holding')
    expect(after([0.4, 0.4, 0.4, 0.27]).status).toBe('weakening')
    expect(after([0.27, 0.26, 0.27, 0.27])).toMatchObject({
      status: 'broken',
      reason:
        '27.0%, 32% below the high of 40.0% on 2026-11-30 (kill at 28.0%): at or past the kill line at 4 of 4 straight weekly checkpoints; 111 of 111 days of history.',
    })
  })

  it('has no fixed line: a low share that never fell is holding', () => {
    expect(evaluate('compute-gpu-spot-tight', weekly(Array<number>(18).fill(0.18))).status).toBe(
      'holding',
    )
  })

  it('is unresolved until it has 111 days of counted readings', () => {
    const short = evaluate('compute-gpu-spot-tight', weekly([0.4, 0.4, 0.3, 0.2]))
    expect(short.status).toBe('unresolved')
    expect(short.reason).toContain('21 of 111 days of history, needs 111.')
  })

  it('is unresolved while fewer than four providers print a spot price', () => {
    const why = '2 of the 4 providers this reading needs print a spot price for the H100.'
    expect(evaluate('compute-gpu-spot-tight', [reading('2026-11-21', 0.4, why)])).toMatchObject({
      status: 'unresolved',
      reason: why,
    })
  })
})

describe('claim 8: capex guidance', () => {
  const guided = (
    ticker: string,
    fiscal_year: number,
    filed: string,
    low: number,
    high = low,
  ): StoredGuidance => ({
    id: `${ticker}-${fiscal_year}-${filed}`,
    ticker,
    cik: '1',
    accession_no: `${ticker}-${filed}`,
    filed,
    fiscal_year,
    low: low * 1e9,
    high: high * 1e9,
    sentence: 'We expect capital expenditures.',
    raw_key: 'guidance/x.htm',
    first_seen_at: `${filed}T12:00:00.000Z`,
    source_url: `https://www.sec.gov/${ticker}/${filed}`,
    fetched_at: `${filed}T12:00:00.000Z`,
  })
  const capex = (ticker: string, year: number, value: number, filed: string): StoredFact => ({
    ticker,
    concept: 'us-gaap:PaymentsToAcquirePropertyPlantAndEquipment',
    dims: '',
    start: `${year}-01-01`,
    end: `${year}-12-31`,
    value: value * 1e9,
    unit: 'USD',
    form: '10-K',
    filed,
    accession_no: `${ticker}-10k-${year}`,
    cik: '1',
    source_url: 'https://www.sec.gov/facts',
    fetched_at: `${filed}T12:00:00.000Z`,
  })
  const SPEC = { cut: 0.1, under: 0.15 }
  const TODAY = '2026-11-20'

  it('counts no one while every filer raises or repeats its figure', () => {
    const read = guidanceShortfalls(
      [
        guided('META', 2026, '2026-04-29', 125, 145),
        guided('META', 2026, '2026-07-29', 130, 145),
        guided('META', 2026, '2026-10-21', 135, 145),
        guided('AMZN', 2026, '2026-10-29', 220),
      ],
      [],
      TODAY,
      SPEC,
    )!
    expect(read.value).toBe(0)
    expect(read.filers.META).toMatchObject({
      state: 'ok',
      guided: { fiscal_year: 2026, low: 135e9, releases: 3, peak_midpoint: 137.5e9, cut: 0 },
      landed: null,
    })
    expect(read.filers.AMZN!.guided).toMatchObject({ releases: 1, peak_midpoint: null, cut: null })
    expect(Object.keys(read.no_figure).sort()).toEqual(['GOOGL', 'MSFT', 'ORCL'])
    expect(read.prov.source_url).toBe('https://www.sec.gov/AMZN/2026-10-29')
  })

  it('counts a filer whose midpoint is 10% or more below the highest it printed for the year', () => {
    const read = guidanceShortfalls(
      [
        guided('META', 2026, '2026-04-29', 130, 150),
        guided('META', 2026, '2026-07-29', 135, 145),
        guided('META', 2026, '2026-10-21', 120, 132),
        guided('GOOGL', 2026, '2026-07-22', 100),
        guided('GOOGL', 2026, '2026-10-28', 91),
      ],
      [],
      TODAY,
      SPEC,
    )!
    expect(read.filers.META).toMatchObject({ state: 'cut', guided: { cut: 0.1 } })
    expect(read.filers.GOOGL).toMatchObject({ state: 'ok', guided: { cut: 0.09 } })
    expect(read.value).toBe(1)
  })

  it('counts a filer whose filed capex lands 15% or more under the last guidance before it', () => {
    const read = guidanceShortfalls(
      [
        guided('GOOGL', 2025, '2025-07-23', 85),
        guided('GOOGL', 2025, '2025-10-29', 91, 93),
        // Filed with the 10-K: not a forecast of the year it closes.
        guided('GOOGL', 2025, '2026-02-04', 60),
        guided('GOOGL', 2026, '2026-10-28', 120),
      ],
      [capex('GOOGL', 2025, 77, '2026-02-04')],
      TODAY,
      SPEC,
    )!
    expect(read.filers.GOOGL).toMatchObject({
      state: 'under',
      landed: { fiscal_year: 2025, low: 91e9, high: 93e9, actual: 77e9, under: 0.1538 },
    })
    expect(read.value).toBe(1)
  })

  it('does not read a cut in a year that has ended, or a landing nobody guided', () => {
    const read = guidanceShortfalls(
      [guided('GOOGL', 2025, '2025-04-24', 100), guided('GOOGL', 2025, '2025-10-29', 80)],
      [],
      TODAY,
      SPEC,
    )
    expect(read).toBeNull()
  })

  it('weakens at one filer and breaks at two', () => {
    const at = (n: number) => evaluate('compute-capex-guidance', [reading('2026-11-20', n)])
    expect(at(0)).toEqual({
      status: 'holding',
      reason: '0 filers, against a kill line of 2 filers.',
      reading_date: '2026-11-20',
      // The level the chart draws as its dashed kill line.
      kill_line: 2,
    })
    expect(at(1)).toMatchObject({
      status: 'weakening',
      reason: '1 filer, against a kill line of 2 filers.',
    })
    expect(at(2).status).toBe('broken')
    expect(evaluate('compute-capex-guidance', []).status).toBe('unresolved')
  })

  it('prints each filer’s guidance beside the reading', () => {
    const read = guidanceShortfalls(
      [guided('META', 2026, '2026-07-29', 130, 150), guided('META', 2026, '2026-10-21', 120, 132)],
      [],
      TODAY,
      SPEC,
    )!
    expect(detailRows({ guidance_filers: read.filers, no_figure: read.no_figure })).toEqual([
      {
        label: 'Meta',
        value: '2026 guidance $120B to $132B, midpoint 10% below its high of $140B',
      },
      { label: 'No figure to read', value: 'Alphabet, Oracle, Amazon, Microsoft' },
    ])
  })
})

describe('claim 9: peak against off-peak throughput', () => {
  const SPEC = { days: 7, min_days: 3, min_labs: 4 }
  const day = (
    lab: string,
    d: string,
    peak: number | null,
    off: number | null,
    over: { model?: string; rate_limited?: number } = {},
  ) => ({
    lab,
    day: d,
    model: over.model ?? `${lab}/flagship`,
    probes: 24,
    rate_limited: over.rate_limited ?? 0,
    failed: 0,
    peak_tps: peak,
    offpeak_tps: off,
    source_url: 'https://openrouter.ai/api/v1/chat/completions',
    fetched_at: `${d}T23:07:00.000Z`,
  })
  const DAYS = ['2026-11-20', '2026-11-21', '2026-11-22']
  const three = (lab: string, peak: number, off: number) => DAYS.map((d) => day(lab, d, peak, off))

  it('reads each lab against itself and takes the median lab, once enough labs have enough days', () => {
    const rows = [
      ...three('openai', 80, 100),
      ...three('anthropic', 45, 50),
      ...three('google', 200, 200),
      ...three('xai', 60, 100),
      // Two days only: not enough to count.
      day('alibaba', '2026-11-21', 10, 100),
      day('alibaba', '2026-11-22', 10, 100),
      // Today is still running.
      day('openai', '2026-11-23', 1, 100),
    ]
    const readings = peakThroughputReadings(rows, '2026-11-23', SPEC)
    // No lab has three days before the 22nd, so there is nothing to read until then.
    expect(readings.map((r) => r.date)).toEqual(['2026-11-22'])
    expect(
      peakThroughputReadings(rows, '2026-11-23', { ...SPEC, min_labs: 5 })[0]!.detail.void_reason,
    ).toBe('4 of the 5 labs this reading needs had 3 days of peak and off-peak probes.')
    const last = readings.at(-1)!
    expect(last.value).toBe(0.85)
    expect(last.detail).toMatchObject({
      window: { from: '2026-11-16', to: '2026-11-22' },
      ratios: { openai: 0.8, anthropic: 0.9, google: 1, xai: 0.6 },
      left_out: { alibaba: '2 of the 3 days it needs with a peak and an off-peak median' },
      quorum: { have: 4, need: 4 },
      void_reason: null,
    })
  })

  it('reads a lab on the model it ran last, and records strain beside the ratio', () => {
    const rows = [
      day('openai', '2026-11-19', 10, 100, { model: 'openai/old' }),
      ...DAYS.map((d) => day('openai', d, 90, 100, { rate_limited: 6 })),
    ]
    const last = peakThroughputReadings(rows, '2026-11-23', { ...SPEC, min_labs: 1 }).at(-1)!
    expect(last.detail.ratios).toEqual({ openai: 0.9 })
    expect(last.detail.strained_share).toBe(0.188)
  })

  it('breaks after 4 straight weekly readings under 70% of off-peak', () => {
    expect(evaluate('compute-peak-throughput', weekly([0.95, 0.9, 0.8, 0.72])).status).toBe(
      'holding',
    )
    expect(evaluate('compute-peak-throughput', weekly([0.95, 0.9, 0.8, 0.69])).status).toBe(
      'weakening',
    )
    expect(evaluate('compute-peak-throughput', weekly([0.69, 0.6, 0.65, 0.69]))).toMatchObject({
      status: 'broken',
      reason: '0.69× against a floor of 0.70×: below at 4 of 4 straight weekly checkpoints.',
    })
  })
})

describe('the press early read beside a filed-revenue claim', () => {
  const period = (start: string, end: string, val: number): RevenuePeriod => ({
    entity_key: `revenue:${start}:${end}`,
    start,
    end,
    days: Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1,
    fy: null,
    fp: null,
    form: 'S-1',
    filed: '2026-10-26',
    accession_no: '0001628280-26-067168',
    filing_url: 'https://www.sec.gov/Archives/edgar/data/2130357/000162828026067168/',
    tag: 'Revenue',
    val,
    frame: null,
    basis: 'prospectus',
    unaudited: true,
    source_url: 'https://www.sec.gov/Archives/edgar/data/2130357/000162828026067168/doc.htm',
    fetched_at: '2026-10-26T12:00:00.000Z',
  })
  const ROWS = [
    period('2025-10-01', '2025-12-31', 2000e6),
    period('2026-01-01', '2026-06-30', 16286e6),
  ]
  // Made up: no stored headline names a quarter Anthropic hasn't filed.
  const headline = (
    published_at: string,
    amount: number,
    periodName: string | null,
  ): StoredHeadline => ({
    lab: 'anthropic',
    metric: 'revenue',
    basis: 'reported',
    currency: 'USD',
    amount,
    amount_text: `$${amount / 1e9} billion`,
    period: periodName,
    title: `Anthropic revenue ${amount}`,
    outlet: 'example.com',
    url: `https://example.com/${published_at}`,
    published_at,
    outlets: 1,
    source_url: `https://example.com/${published_at}`,
    fetched_at: '2027-01-20T00:00:00.000Z',
    found_at: '2027-01-20T00:00:00.000Z',
  })

  it('groups reports by the unfiled period they name and reads growth off the filed year before', () => {
    const read = pressEarlyRead(
      'anthropic',
      [
        headline('2027-01-12T10:00:00.000Z', 9.0e9, '2026-Q4'),
        headline('2027-01-14T10:00:00.000Z', 10.0e9, '2026-Q4'),
        headline('2027-01-15T10:00:00.000Z', 9.4e9, '2026-Q4'),
        // Names no period and matches nothing filed.
        headline('2027-01-16T10:00:00.000Z', 50e9, null),
        // The quarter was still running: a forecast, not a report.
        headline('2026-11-30T10:00:00.000Z', 8e9, '2026-Q4'),
        // Already filed: a repeat, not an early read.
        headline('2026-11-01T10:00:00.000Z', 16.3e9, null),
      ],
      ROWS,
    )
    expect(read.periods).toHaveLength(1)
    expect(read.periods[0]).toMatchObject({
      label: 'Q4 2026',
      start: '2026-10-01',
      end: '2026-12-31',
      reports: 3,
      median: 9.4e9,
      low: 9.0e9,
      high: 10.0e9,
      base: { label: 'Q4 2025', value: 2000e6 },
      latest: { url: 'https://example.com/2027-01-15T10:00:00.000Z' },
    })
    expect(read.periods[0]!.implied_growth).toBeCloseTo(3.7, 5)
    expect(read.unplaced).toBe(1)
    expect(earlyReadLines(read)).toEqual({
      periods: [
        'Q4 2026: $9.40B at the median of 3 press reports, from $9.00B to $10.0B. Against the $2.00B filed for Q4 2025, that is growth of 370%.',
      ],
      unplaced:
        '1 press report matches no filed figure and names no period, so we can’t tie it to one.',
      record:
        'No press report has been settled by a filing yet, so there is no past error to show.',
    })
  })

  it('says so when no report names an unfiled period, and still shows the past error', () => {
    const read = pressEarlyRead(
      'anthropic',
      [headline('2026-09-20T10:00:00.000Z', 16.2e9, null)],
      ROWS,
    )
    expect(read.periods).toEqual([])
    expect(read.record).toMatchObject({ periods: 1, reports: 1, median_lead_days: 36 })
    expect(earlyReadSummary(read)).toBe(
      'No press report names a period that isn’t filed yet. Filings have settled 1 press report so far. They were a median 0.5% off and ran a median 36 days before the filing.',
    )
  })
})
