import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import {
  adjustSplits,
  buildPanel,
  dailyBar,
  easternDst,
  hourlyCollector,
  ITCH_THROUGH,
  pullMarket,
  readCsv,
  unexplainedJumps,
} from '../server/signals/market'

const db = drizzle(env.DB, { schema })

const DAILY = `ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol
2024-07-10T00:00:00.000000000Z,35,90,1429,1746.0,1766.4,1726.3,1744.690000000,4107420,AVGO
2024-07-15T00:00:00.000000000Z,35,90,1429,170.0,173.5,169.2,171.420000000,22999201,AVGO
`

describe('parsing', () => {
  it('reads a daily bar per session', () => {
    expect(readCsv(DAILY).map(dailyBar)).toEqual([
      { symbol: 'AVGO', date: '2024-07-10', close: 1744.69, volume: 4107420 },
      { symbol: 'AVGO', date: '2024-07-15', close: 171.42, volume: 22999201 },
    ])
  })

  it('refuses a body without the columns it needs', () => {
    expect(() => readCsv('ts_event,price\n2024-01-01,1\n')).toThrow(/lacks a column/)
  })

  it('knows US daylight time', () => {
    expect(easternDst('2024-03-09')).toBe(false)
    expect(easternDst('2024-03-10')).toBe(true)
    expect(easternDst('2024-11-02')).toBe(true)
    expect(easternDst('2024-11-03')).toBe(false)
    expect(easternDst('2024-01-15')).toBe(false)
  })

  it('takes the close of the 15:00 ET hourly bar, under either clock', () => {
    const csv = `ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol
2024-06-28T18:00:00.000000000Z,34,2,1,1,1,1,1597.22,10,AVGO
2024-06-28T19:00:00.000000000Z,34,2,1,1,1,1,1605.53,20,AVGO
2024-06-28T20:00:00.000000000Z,34,2,1,1,1,1,1607.77,30,AVGO
2024-01-12T19:00:00.000000000Z,34,2,1,1,1,1,99,5,FB
2024-01-12T20:00:00.000000000Z,34,2,1,1,1,1,101,5,FB
`
    const collect = hourlyCollector('META')
    for (const b of readCsv(csv)) collect.add(b)
    expect(collect.bars()).toEqual([
      { symbol: 'META', date: '2024-06-28', close: 1605.53, volume: 60 },
      { symbol: 'META', date: '2024-01-12', close: 101, volume: 10 },
    ])
  })
})

describe('adjustment', () => {
  it('divides closes before a split by its ratio', () => {
    const bars = [
      { date: '2024-07-12', close: 1700 },
      { date: '2024-07-15', close: 171 },
    ]
    expect(adjustSplits(bars, [{ date: '2024-07-15', ratio: 10 }])).toEqual([
      { date: '2024-07-12', close: 170 },
      { date: '2024-07-15', close: 171 },
    ])
  })

  it('flags an overnight move a split would explain', () => {
    expect(
      unexplainedJumps('XYZ', [
        { date: '2024-01-02', close: 100 },
        { date: '2024-01-03', close: 50 },
      ]),
    ).toEqual(['XYZ 2024-01-03'])
  })

  it('applies the known splits and drops history before a break', () => {
    const panel = buildPanel([
      { symbol: 'SPY', date: '2024-07-12', close: 500 },
      { symbol: 'SPY', date: '2024-07-15', close: 500 },
      { symbol: 'AVGO', date: '2024-07-12', close: 1700 },
      { symbol: 'AVGO', date: '2024-07-15', close: 171 },
      { symbol: 'SPY', date: '2023-07-12', close: 450 },
      { symbol: 'CORZ', date: '2023-07-12', close: 0.1 },
      { symbol: 'CORZ', date: '2024-07-12', close: 12 },
    ])
    expect(panel.dates).toEqual(['2023-07-12', '2024-07-12', '2024-07-15'])
    expect(panel.close.get('AVGO')).toEqual([null, 170, 171])
    // The old equity, cancelled in bankruptcy, is not CORZ's history.
    expect(panel.close.get('CORZ')).toEqual([null, 12, null])
    expect(panel.jumps).toEqual([])
  })
})

describe('pullMarket', () => {
  beforeEach(async () => {
    await db.delete(schema.marketBars)
    await db.delete(schema.marketFetches)
  })

  it('clamps to the dataset’s end, stores the bars, and never sends the key anywhere but Databento', async () => {
    const asked: { url: string; body: string; auth: string | null }[] = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      asked.push({
        url,
        body: String(init?.body ?? ''),
        auth: new Headers(init?.headers).get('Authorization'),
      })
      if (url.includes('metadata.get_dataset_range')) {
        return Response.json({ schema: { 'ohlcv-1d': { end: '2024-07-16T00:00:00.000000000Z' } } })
      }
      const body = new URLSearchParams(String(init?.body))
      if (body.get('dataset') === 'EQUS.SUMMARY') return new Response(DAILY)
      return new Response(
        'ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol\n',
      )
    }) as typeof fetch

    const report = await pullMarket(
      db,
      { apiKey: 'db-test-key', fetch: fetcher, now: new Date('2024-07-16T07:00:00Z') },
      { symbols: ['AVGO'] },
    )
    expect(report.failed).toEqual([])
    expect(report.daily.rows).toBe(2)
    expect(asked.every((a) => a.url.startsWith('https://hist.databento.com/v0/'))).toBe(true)
    expect(asked.every((a) => a.auth === `Basic ${btoa('db-test-key:')}`)).toBe(true)
    expect(
      asked.every((a) => !a.url.includes('db-test-key') && !a.body.includes('db-test-key')),
    ).toBe(true)
    const daily = new URLSearchParams(asked.find((a) => a.body.includes('EQUS.SUMMARY'))!.body)
    expect(daily.get('end')).toBe('2024-07-16T00:00:00.000000000Z')

    const fetches = await db.select().from(schema.marketFetches)
    expect(fetches.find((f) => f.dataset === 'EQUS.SUMMARY')!.through).toBe('2024-07-15')
    expect(fetches.find((f) => f.dataset === 'XNAS.ITCH')!.through).toBe(ITCH_THROUGH)
    const bars = await db.select().from(schema.marketBars)
    expect(bars.map((b) => [b.date, b.close])).toEqual([
      ['2024-07-10', 1744.69],
      ['2024-07-15', 171.42],
    ])
  })

  it('reports Databento’s message on a refusal and carries on', async () => {
    const fetcher = (async (input: RequestInfo | URL) =>
      String(input).includes('metadata')
        ? Response.json({ end: '2024-07-16T00:00:00Z' })
        : Response.json(
            { detail: { message: 'Insufficient credits.' } },
            { status: 402 },
          )) as typeof fetch
    const report = await pullMarket(
      db,
      { apiKey: 'k', fetch: fetcher, now: new Date('2024-07-16T07:00:00Z') },
      { symbols: ['AVGO'] },
    )
    expect(report.failed.map((f) => f.detail)).toEqual([
      'Databento EQUS.SUMMARY 402: Insufficient credits.',
      'Databento XNAS.ITCH 402: Insufficient credits.',
    ])
  })

  it('retries a gateway timeout, and gives up after the last retry', async () => {
    let dailyCalls = 0
    const waits: number[] = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('metadata')) return Response.json({ end: '2024-07-16T00:00:00Z' })
      const body = new URLSearchParams(String(init?.body))
      if (body.get('dataset') === 'EQUS.SUMMARY') {
        dailyCalls++
        return dailyCalls === 1
          ? new Response('error code: 504', { status: 504 })
          : new Response(DAILY)
      }
      return new Response('error code: 504', { status: 504 })
    }) as typeof fetch
    const report = await pullMarket(
      db,
      {
        apiKey: 'k',
        fetch: fetcher,
        now: new Date('2024-07-16T07:00:00Z'),
        sleep: async (ms) => {
          waits.push(ms)
        },
      },
      { symbols: ['AVGO'] },
    )
    expect(dailyCalls).toBe(2)
    expect(report.daily.rows).toBe(2)
    // The backfill kept failing: one try and two retries, then reported.
    expect(report.failed.map((f) => f.detail)).toEqual(['Databento XNAS.ITCH 504: error code: 504'])
    expect(waits).toEqual([2_000, 2_000, 8_000])
  })

  it('splits a first pull of many symbols into batches', async () => {
    const batches: number[] = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('metadata')) return Response.json({ end: '2024-07-16T00:00:00Z' })
      const body = new URLSearchParams(String(init?.body))
      if (body.get('dataset') === 'EQUS.SUMMARY')
        batches.push(body.get('symbols')!.split(',').length)
      return new Response(
        'ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol\n',
      )
    }) as typeof fetch
    const symbols = Array.from({ length: 30 }, (_, i) => `S${i}`)
    await pullMarket(
      db,
      { apiKey: 'k', fetch: fetcher, now: new Date('2024-07-16T07:00:00Z'), sleep: async () => {} },
      { symbols, backfillLimit: 0 },
    )
    expect(batches).toEqual([12, 12, 6])
  })
})
