import { beforeEach, describe, expect, it } from 'vitest'

import tiesJson from '../server/curated/print-ties.json'
import { ACCTON_REVENUE, runPrintReads, TSMC_6K, TWSE_REVENUE } from '../server/prints/ingest'
import {
  parseAcctonRevenue,
  parseTsmcRevenue6k,
  parseTwseRevenue,
  rocPeriod,
  shiftPeriod,
  tsmcCandidates,
  twDueOn,
  type PrintObservation,
} from '../server/prints/parse'
import { printsStamp, storeObservations } from '../server/prints/store'
import { fixtureText } from '#layers/core/test/pipeline/fixtures'

// The print reader on the committed bytes: the exchange feed, Accton's page
// and three of TSMC's 6-Ks (2015, 2019, 2026), then the append-only store and
// the reader end to end against a fake fetcher.

const TWSE = fixtureText('fixtures/prints/twse-t187ap05_L.json')
const ACCTON = fixtureText('fixtures/prints/accton-monthly.html')
const SUBMISSIONS = fixtureText('fixtures/prints/tsm-submissions.json')
const TSM_2026 = fixtureText('fixtures/prints/tsm-revenue-20261110.htm')
const TSM_2019 = fixtureText('fixtures/prints/tsm-revenue-20190410.htm')
const TSM_2015 = fixtureText('fixtures/prints/tsm-revenue-20150410.htm')
const TSM_2020 = fixtureText('fixtures/prints/tsm-revenue-20200810.htm')
const TSM_2019_OCT = fixtureText('fixtures/prints/tsm-revenue-20191108.htm')

const pick = (obs: PrintObservation[], entity: string, observed_as: string) =>
  obs.find((o) => o.entity === entity && o.observed_as === observed_as)!

describe('the period helpers', () => {
  it('reads ROC year-months and shifts across years', () => {
    expect(rocPeriod('11510')).toBe('2026-10')
    expect(rocPeriod('10401')).toBe('2015-01')
    expect(() => rocPeriod('11513')).toThrow()
    expect(shiftPeriod('2026-01', -1)).toBe('2025-12')
    expect(shiftPeriod('2026-10', -12)).toBe('2025-10')
    expect(twDueOn('2026-12')).toBe('2027-01-10')
  })
})

describe('parseTwseRevenue', () => {
  const obs = parseTwseRevenue(TWSE)

  it('keeps the eight tracked companies, three figures each, in TWD', () => {
    expect(new Set(obs.map((o) => o.entity))).toEqual(
      new Set(PRINT_ENTITIES.filter((e) => e.code).map((e) => e.id)),
    )
    expect(obs).toHaveLength(24)
    const tsmc = pick(obs, 'tsmc', 'print')
    expect(tsmc).toMatchObject({ period: '2026-10', value: 586_890_319_000, yoy_pct: 59.71 })
    expect(tsmc.due_on).toBe('2026-11-10')
    expect(pick(obs, 'tsmc', 'prior_month')).toMatchObject({ period: '2026-09', yoy_pct: null })
    expect(pick(obs, 'quanta', 'year_ago')).toMatchObject({
      period: '2025-10',
      value: 173_195_793_000,
    })
  })

  it('throws on a body that is not the feed, or has none of the companies', () => {
    expect(() => parseTwseRevenue('{}')).toThrow()
    expect(() => parseTwseRevenue('[{"公司代號":"1101","資料年月":"11510"}]')).toThrow()
  })
})

describe('parseTsmcRevenue6k', () => {
  it('reads the table of a 2026 report in NT$ million, with the acceptance time', () => {
    const obs = parseTsmcRevenue6k(TSM_2026, '2026-11-10T12:01:33.000Z')!
    expect(pick(obs, 'tsmc', 'print')).toMatchObject({
      period: '2026-10',
      value: 586_890e6,
      yoy_pct: 59.7,
      published_at: '2026-11-10T12:01:33.000Z',
    })
    expect(pick(obs, 'tsmc', 'prior_month')).toMatchObject({ period: '2026-09', value: 511_857e6 })
    expect(pick(obs, 'tsmc', 'year_ago')).toMatchObject({ period: '2025-10', value: 367_473e6 })
  })

  it('reads a decrease written in parentheses (2019) and the 2015 layout', () => {
    expect(pick(parseTsmcRevenue6k(TSM_2019, 'x')!, 'tsmc', 'print')).toMatchObject({
      period: '2019-03',
      value: 79_722e6,
      yoy_pct: -23.1,
    })
    expect(pick(parseTsmcRevenue6k(TSM_2015, 'x')!, 'tsmc', 'print')).toMatchObject({
      period: '2015-03',
      value: 72_269e6,
      yoy_pct: 44.7,
    })
    // A month-on-month decrease in full-width parentheses: "（12.3）".
    const july2020 = parseTsmcRevenue6k(TSM_2020, 'x')!
    expect(pick(july2020, 'tsmc', 'print')).toMatchObject({
      period: '2020-07',
      value: 105_963e6,
      yoy_pct: 25,
    })
    expect(pick(july2020, 'tsmc', 'prior_month')).toMatchObject({
      period: '2020-06',
      value: 120_878e6,
    })
    // The table headed "(in NT$ million)" rather than "(Unit:NT$ million)".
    expect(pick(parseTsmcRevenue6k(TSM_2019_OCT, 'x')!, 'tsmc', 'print')).toMatchObject({
      period: '2019-10',
      value: 106_040e6,
      yoy_pct: 4.4,
    })
  })

  it('returns null for a 6-K that is not a revenue report', () => {
    expect(parseTsmcRevenue6k('<p>Board of directors meeting resolutions</p>', 'x')).toBeNull()
  })
})

describe('tsmcCandidates', () => {
  it('keeps 6-Ks filed in the first twelve days of a month, newest first, skipping named others', () => {
    const c = tsmcCandidates(SUBMISSIONS)
    expect(c.map((x) => x.filed)).toEqual([
      '2026-11-10',
      '2026-10-08',
      '2026-09-10',
      '2026-08-10',
      '2022-11-10',
      '2019-04-10',
      '2015-04-10',
    ])
    expect(c[0]!.url).toBe(
      'https://www.sec.gov/Archives/edgar/data/1046179/000104617926000796/tsm-revenue20261110.htm',
    )
    expect(c[0]!.accepted_at).toBe('2026-11-10T12:01:33.000Z')
  })

  it('refuses another filer’s feed', () => {
    expect(() => tsmcCandidates(SUBMISSIONS.replace('"0001046179"', '"0000002488"'))).toThrow()
  })
})

describe('parseAcctonRevenue', () => {
  it('reads every month of the table, July 2023 on', () => {
    const obs = parseAcctonRevenue(ACCTON)
    const prints = obs.filter((o) => o.observed_as === 'print')
    expect(prints).toHaveLength(40)
    expect(prints[0]).toMatchObject({ period: '2026-10', value: 44_662_669_000, yoy_pct: 91.16 })
    expect(prints.at(-1)!.period).toBe('2023-07')
    // The exchange feed agrees on the same month.
    expect(pick(parseTwseRevenue(TWSE), 'accton', 'print').value).toBe(prints[0]!.value)
  })

  it('throws when the unit line is gone', () => {
    expect(() => parseAcctonRevenue('<table></table>')).toThrow()
  })
})

const obs = (
  period: string,
  value: number,
  observed_as: PrintObservation['observed_as'] = 'print',
) =>
  ({
    series: 'tw_revenue',
    entity: 'quanta',
    ticker: '2382.TW',
    period,
    window: 'month',
    value,
    currency: 'TWD',
    yoy_pct: null,
    observed_as,
    published_at: null,
    due_on: twDueOn(period),
  }) satisfies PrintObservation

const write = (fetched_at: string) => ({
  source_id: 'test-source',
  source_url: 'https://example.com/feed',
  fetched_at,
  raw_key: null,
  basis: 'live' as const,
})

beforeEach(async () => {
  for (const table of [schema.hardwarePrints, schema.printDocuments, schema.opsEvents]) {
    await db.delete(table)
  }
})

describe('storeObservations', () => {
  it('appends a revision as the next vintage and never rewrites a row', async () => {
    expect(
      await storeObservations(db, [obs('2026-09', 100e9)], write('2026-10-08T06:00:00Z')),
    ).toEqual({
      added: 1,
      revised: 0,
    })
    // The same figure again, restated a month later: nothing new.
    expect(
      await storeObservations(
        db,
        [obs('2026-10', 110e9), obs('2026-09', 100e9, 'prior_month')],
        write('2026-11-08T06:00:00Z'),
      ),
    ).toEqual({ added: 1, revised: 0 })
    // A later release restates September differently: a second vintage.
    expect(
      await storeObservations(
        db,
        [obs('2026-09', 101e9, 'year_ago')],
        write('2027-10-08T06:00:00Z'),
      ),
    ).toEqual({ added: 0, revised: 1 })
    const sept = (await printRows(db)).filter((r) => r.period === '2026-09')
    expect(sept.map((r) => [r.vintage, r.value, r.first_seen_at, r.observed_as])).toEqual([
      [1, 100e9, '2026-10-08T06:00:00Z', 'print'],
      [2, 101e9, '2027-10-08T06:00:00Z', 'year_ago'],
    ])
    const [point] = buildPoints(sept)
    expect(point).toMatchObject({
      value: 101e9,
      first_value: 100e9,
      first_seen_at: '2026-10-08T06:00:00Z',
    })
  })
})

const ok = (text: string): FetchOutcome => ({ ok: true, status: 200, text, bytes: text.length })
const DOCS: Record<string, string> = {
  'https://www.sec.gov/Archives/edgar/data/1046179/000104617926000796/tsm-revenue20261110.htm':
    TSM_2026,
  'https://www.sec.gov/Archives/edgar/data/1046179/000119312519102369/d696695d6k.htm': TSM_2019,
  'https://www.sec.gov/Archives/edgar/data/1046179/000119312515125178/d906407d6k.htm': TSM_2015,
}
const fetcher: SourceFetcher = async (source) => {
  if (source.url === TWSE_REVENUE.url) return ok(TWSE)
  if (source.url === ACCTON_REVENUE.url) return ok(ACCTON)
  if (source.url === TSMC_6K.submissions) return ok(SUBMISSIONS)
  const doc = DOCS[source.url]
  if (doc) return ok(doc)
  return ok(
    '<html><p>Taiwan Semiconductor Manufacturing Company Limited announces a dividend.</p></html>',
  )
}

describe('runPrintReads', () => {
  it('backfills on a source’s first read, then reads only what changed', async () => {
    const raw = new Map<string, string>()
    const deps = {
      raw: { put: async (key: string, body: string) => void raw.set(key, body) },
      fetcher,
      now: new Date('2026-11-21T06:41:00Z'),
    }
    const first = await runPrintReads(db, deps)
    expect(first.feeds[TWSE_REVENUE.source_id]).toMatchObject({ status: 'read', added: 24 })
    expect(first.feeds[ACCTON_REVENUE.source_id]!.status).toBe('read')
    expect(first.tsmc).toMatchObject({ read: 7, reports: 3, pending: 0 })

    const rows = await printRows(db)
    expect(
      rows.every((r) => r.source_id !== TWSE_REVENUE.source_id || r.basis === 'backfill'),
    ).toBe(true)
    const tsmc6k = rows.filter((r) => r.source_id === TSMC_6K.source_id && r.period === '2026-10')
    expect(tsmc6k).toMatchObject([{ basis: 'backfill', published_at: '2026-11-10T12:01:33.000Z' }])
    expect(raw.has('prints/tsmc/0001046179-26-000796.htm')).toBe(true)

    const stamp = await printsStamp(db)
    const second = await runPrintReads(db, deps)
    expect(second.feeds[TWSE_REVENUE.source_id]!.status).toBe('unchanged')
    expect(second.tsmc.read).toBe(0)
    expect(await printsStamp(db)).toBe(stamp)

    const data = await queryPrints(db, queryContext(fixtureText('sources.yaml'), null))
    const tsmc = data.series.find((s) => s.entity.id === 'tsmc')!
    // The exchange feed's NT$ thousand wins over the 6-K's NT$ million for the same month.
    expect(tsmc.points[0]).toMatchObject({
      period: '2026-10',
      value: 586_890_319_000,
      published_at: '2026-11-10T12:01:33.000Z',
    })
    expect(tsmc.points.some((p) => p.period === '2015-03')).toBe(true)
    expect(data.series.find((s) => s.entity.id === 'accton')!.points).toHaveLength(49)
  })
})

describe('the ties', () => {
  it('validate, quote each source, and give every Taiwan company at least one', () => {
    const ties = curatedPrintTies.parse(tiesJson).ties
    for (const e of PRINT_ENTITIES) {
      expect(
        ties.some((t) => t.entity === e.id),
        e.id,
      ).toBe(true)
    }
    for (const t of ties) expect(t.quote.length).toBeGreaterThanOrEqual(20)
  })

  it('reach the listed companies, TSMC under TSM and the others under their .TW listing', () => {
    const { companies, counts } = buildListed(
      { nodes: [], edges: [] },
      { companies: [], rows: [] },
      { tickers: [] },
      printTies,
    )
    const tsm = companies.find((c) => c.ticker === 'TSM')!
    expect(tsm.ties).toMatchObject([{ source: 'prints', reads: 'revenue', layer: 'foundry' }])
    const honHai = companies.find((c) => c.ticker === '2317.TW')!
    expect(honHai.labs).toContain('openai')
    expect(companies.find((c) => c.ticker === '000660.KS')!.ties[0]).toMatchObject({
      reads: 'member',
    })
    expect(counts.prints).toBe(companies.length)
  })
})
