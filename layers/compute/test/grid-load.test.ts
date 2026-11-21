import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import epochTimelines from '~~/fixtures/recipes/epoch-data-center-timelines.csv?raw'
import epochSites from '~~/fixtures/recipes/epoch-data-centers.csv?raw'
import * as schema from '~~/server/db/schema'
import type { FetchOutcome, SourceFetcher } from '#layers/core/server/pipeline/fetch'
import {
  csvFields,
  eia930FileUrl,
  periodsDue,
  periodsThrough,
  readEia930,
} from '../server/power/eia930'
import { eiaDailyUrl, hoursInLocalDay, readEiaDaily, zoneGroups } from '../server/power/eia-api'
import { runErcotLargeLoads } from '../server/power/ercot-large-loads'
import {
  ercotFacts,
  ercotListings,
  ercotReportLinks,
  reportPeriod,
} from '../server/power/ercot-reports'
import { API_PERIOD, runGridLoad } from '../server/power/grid-load'
import { GRID_AREA_TABLE, ercotSeries, queryGridLoad } from '../server/power/grid-query'
import { pdfPages } from '#layers/core/server/pipeline/pdf-text'
import { seedHandTies } from '../server/power/store'
import {
  EPOCH_DATA_CENTERS,
  EPOCH_DATA_CENTER_TIMELINES,
} from '../server/recipes/epoch-data-centers'
import { runRecipes } from '#layers/terminal/server/theses/recipes/run'
import { SIGNALS } from '#layers/terminal/server/signals/registry'
import { createLoader } from '#layers/terminal/server/signals/sources'
import { queryContext } from '#layers/core/server/utils/terminal-db'
import { GRID_AREAS, gridMonths, gridWeeks } from '../shared/utils/grid-load'
import { fixtureText } from '#layers/core/test/pipeline/fixtures'

// The grid-load reader: EIA-930's six-month files read line by line into
// days, ERCOT's monthly PDFs read for their large-load sentences, and the
// join that places each lab site in a balancing authority.

const db = drizzle(env.DB, { schema })

const EIA = fixtureText('fixtures/grid-load/eia930-balance-2026-jul-dec.csv')
const pdf = (path: string) => {
  const bin = atob(fixtureText(path).replace(/\s+/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
const OVERVIEW = pdf('fixtures/grid-load/ercot-monthly-operational-overview-july-2025.pdf.base64')
const MONTHLY = pdf('fixtures/grid-load/ercot-monthly-april-2026.pdf.base64')
const OVERVIEW_URL =
  'https://www.ercot.com/files/docs/2025/08/15/ERCOT-Monthly-Operational-Overview-July-2025.pdf'
const MONTHLY_URL = 'https://www.ercot.com/files/docs/2026/05/13/ERCOT-Monthly-April-2026-FINAL.pdf'

describe('EIA-930 files', () => {
  it('names a half-year’s file and the halves a run reads', () => {
    expect(eia930FileUrl('2026H2')).toBe(
      'https://www.eia.gov/electricity/gridmonitor/sixMonthFiles/EIA930_BALANCE_2026_Jul_Dec.csv',
    )
    const now = new Date('2026-08-01T00:00:00Z')
    const all = periodsThrough(now)
    expect(all[0]).toBe('2018H1')
    expect(all.at(-1)).toBe('2026H2')
    expect(all).toHaveLength(18)
    // The current half, the one that closed a month ago, then the newest unread.
    expect(periodsDue(now, new Set())).toEqual([
      '2026H2',
      '2026H1',
      '2025H2',
      '2025H1',
      '2024H2',
      '2024H1',
    ])
    // Months after a half closes, it is no longer re-read.
    expect(periodsDue(new Date('2026-11-21T00:00:00Z'), new Set(all))).toEqual(['2026H2'])
  })

  it('splits quoted fields and keeps a comma inside quotes', () => {
    expect(csvFields('a,"1,234",,x')).toEqual(['a', '1,234', '', 'x'])
    expect(csvFields('"Balancing Authority","Data Date"')).toEqual([
      'Balancing Authority',
      'Data Date',
    ])
  })

  it('sums the tracked authorities’ hours into days and drops the rest', () => {
    const { lines, days } = readEia930(EIA)
    expect(days).toEqual([
      { ba: 'ERCO', date: '2026-07-01', mwh: 1670661, hours: 24 },
      { ba: 'ERCO', date: '2026-07-02', mwh: 1667769, hours: 24 },
      { ba: 'PJM', date: '2026-07-01', mwh: 3232119, hours: 24 },
    ])
    // The kept lines are the file's own, header first; AECI's are not among them.
    expect(lines.split('\n')[0]).toBe(EIA.split('\n')[0])
    expect(lines).not.toContain('AECI,')
    expect(EIA).toContain(lines.split('\n')[1]!)
  })

  it('refuses a file without the adjusted demand column', () => {
    expect(() =>
      readEia930('"Balancing Authority","Data Date","Demand (MW)"\nERCO,07/01/2026,5\n'),
    ).toThrow(/Demand \(MW\) \(Adjusted\)/)
  })
})

describe('EIA API v2', () => {
  const API = fixtureText('fixtures/grid-load/eia-api-daily-central-2026-07-01.json')

  it('reads the same days the six-month file sums to', () => {
    const { days, total } = readEiaDaily(API)
    expect(total).toBe(4)
    const files = readEia930(EIA).days.filter((d) => d.ba === 'ERCO')
    expect(days.filter((d) => d.ba === 'ERCO')).toEqual(files)
    expect(days.find((d) => d.ba === 'MISO')).toEqual({
      ba: 'MISO',
      date: '2026-07-01',
      mwh: 2466800,
      hours: 24,
    })
  })

  it('counts a local day’s hours across clock changes', () => {
    expect(hoursInLocalDay('2026-03-08', 'America/Chicago')).toBe(23)
    expect(hoursInLocalDay('2026-11-01', 'America/New_York')).toBe(25)
    expect(hoursInLocalDay('2026-03-08', 'America/Phoenix')).toBe(24)
    expect(hoursInLocalDay('2026-07-01', 'America/Chicago')).toBe(24)
  })

  it('asks per clock, with no key in the URL', () => {
    expect([...zoneGroups().keys()].sort()).toEqual(['Arizona', 'Central', 'Eastern'])
    const url = eiaDailyUrl({
      bas: ['ERCO', 'MISO'],
      zone: 'Central',
      start: '2019-01-01',
      offset: 0,
    })
    expect(url).not.toMatch(/api_key/i)
    expect(new URL(url).searchParams.getAll('facets[respondent][]')).toEqual(['ERCO', 'MISO'])
  })

  it('refuses a row on another clock or a response with no data', () => {
    const wrong = API.replace(/"timezone":"Central"/, '"timezone":"Eastern"')
    expect(() => readEiaDaily(wrong)).toThrow(/not Central/)
    expect(() => readEiaDaily('{"error":"invalid api_key"}')).toThrow(/EIA API error/)
  })
})

describe('the derived series', () => {
  const days = (from: string, n: number, mw: number) =>
    Array.from({ length: n }, (_, i) => ({
      date: new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10),
      mwh: mw * 24,
      hours: 24,
    }))

  it('averages whole months and compares each with the year before', () => {
    const rows = [
      ...days('2025-01-01', 31, 100),
      ...days('2026-01-01', 31, 110),
      ...days('2026-02-01', 10, 120),
    ]
    const m = gridMonths(rows)
    // February 2026 is short and left out.
    expect(m.map((x) => x.month)).toEqual(['2025-01', '2026-01'])
    expect(m[0]).toMatchObject({ avg_mw: 100, yoy: null })
    expect(m[1]!.yoy).toBeCloseTo(0.1)
  })

  it('averages whole Monday-to-Sunday weeks against 52 weeks before', () => {
    // 2025-01-06 and 2026-01-05 are Mondays, 364 days apart.
    const w = gridWeeks([...days('2025-01-06', 7, 200), ...days('2026-01-05', 9, 220)])
    expect(w.map((x) => x.week)).toEqual(['2025-01-06', '2026-01-05'])
    expect(w[1]!.yoy).toBeCloseTo(0.1)
  })
})

describe('ERCOT’s reports', () => {
  it('reads the overview’s approved and observed large load', async () => {
    const link = {
      url: OVERVIEW_URL,
      series: 'operational-overview' as const,
      title: 'ERCOT Monthly Operational Overview July 2025',
      posted: '2025-08-15',
    }
    const facts = ercotFacts(await pdfPages(OVERVIEW), link)
    expect(facts.map((f) => [f.metric, f.period, f.value])).toEqual([
      ['approved_to_energize_mw', '2025-07', 7150],
      ['observed_peak_mw', '2025-07', 3820],
    ])
    expect(facts[0]!.quote).toMatch(/^Of the 7150 MW that have received Approval to Energize/)
    expect(facts[0]!.quote).toMatch(/July 2025.*\.$/)
  })

  it('reads the queue and the energized total from the ERCOT Monthly', async () => {
    const link = {
      url: MONTHLY_URL,
      series: 'monthly' as const,
      title: 'ERCOT Monthly April 2026',
      posted: '2026-05-13',
    }
    const facts = ercotFacts(await pdfPages(MONTHLY), link)
    expect(facts.map((f) => [f.metric, f.period, f.value, f.horizon])).toEqual([
      ['queue_mw', '2026-04', 445800, '2033'],
      ['observed_energized_mw', '2026-04', 5900, null],
      ['approved_not_operational_mw', '2026-04', 3200, null],
    ])
    expect(facts[0]!.quote).toContain('445.8 gigawatts (GW) by 2033')
  })

  it('throws on a misread number and returns nothing for a report without the sentence', () => {
    const link = {
      url: 'x',
      series: 'operational-overview' as const,
      title: 't',
      posted: '2026-01-01',
    }
    expect(() =>
      ercotFacts(
        [
          'Of the 4,000 MW that have received Approval to Energize, ERCOT has observed a non-simultaneous monthly peak consumption of 9,000 MW in May 2026.',
        ],
        link,
      ),
    ).toThrow(/implausible/)
    expect(ercotFacts(['Peak demand was 77,478 MW.'], link)).toEqual([])
  })

  it('finds the reports on the listing pages', () => {
    const board = ercotReportLinks(
      fixtureText('fixtures/grid-load/ercot-board.html'),
      'operational-overview',
    )
    const y2025 = ercotReportLinks(
      fixtureText('fixtures/grid-load/ercot-board-2025.html'),
      'operational-overview',
    )
    const news = ercotReportLinks(
      fixtureText('fixtures/grid-load/ercot-presentations.html'),
      'monthly',
    )
    expect(board).toHaveLength(10)
    expect(y2025).toHaveLength(12)
    expect(news.map((n) => n.posted)).toEqual([
      '2025-12-19',
      '2026-01-20',
      '2026-02-13',
      '2026-03-17',
      '2026-05-13',
      '2026-06-19',
      '2026-07-10',
    ])
    expect(news.find((n) => n.url === MONTHLY_URL)?.title).toBe('ERCOT Monthly April 2026')
    // The September 2026 overview's file name carries no year: its month is the one before it was posted.
    const sep = board.find((b) => b.url.endsWith('Overview-September.pdf'))!
    expect(reportPeriod(sep)).toBe('2026-09')
    expect(ercotListings(new Date('2026-11-21T00:00:00Z')).map((l) => l.url)).toEqual([
      'https://www.ercot.com/committees/board',
      'https://www.ercot.com/committees/board/2025',
      'https://www.ercot.com/news/presentations',
    ])
  })

  it('keeps every vintage and shows each month from the newest report', () => {
    const row = (posted: string, metric: string, period: string, value: number) => ({
      id: `${posted}${metric}`,
      report_url: `r${posted}`,
      metric,
      period,
      value,
      qualifier: null,
      horizon: null,
      quote: `q${posted}`,
      posted,
      raw_key: 'k',
      source_url: `r${posted}`,
      fetched_at: '2026-11-21T00:00:00.000Z',
    })
    const s = ercotSeries(
      [
        row('2026-01-15', 'approved_to_energize_mw', '2026-01', 8787),
        row('2026-01-15', 'observed_peak_mw', '2026-01', 3349),
        row('2026-02-18', 'approved_to_energize_mw', '2026-01', 8787),
        row('2026-02-18', 'observed_peak_mw', '2026-01', 4049),
      ],
      2,
    )
    expect(s.months).toEqual([
      expect.objectContaining({
        period: '2026-01',
        observed_peak_mw: 4049,
        approved_mw: 8787,
        vintages: 2,
        posted: '2026-02-18',
      }),
    ])
  })
})

// ─── End to end, against D1 ───────────────────────────────────────────────────

const ok = (text: string): FetchOutcome => ({ ok: true, status: 200, text, bytes: text.length })
const EPOCH: Record<string, string> = {}
const stored = new Map<string, unknown>()
const put = async (key: string, body: string | Uint8Array) => {
  stored.set(key, body)
}

beforeAll(async () => {
  const epochAt = new Date('2026-11-04T12:00:00Z')
  EPOCH[EPOCH_DATA_CENTERS.url(epochAt)] = epochSites
  EPOCH[EPOCH_DATA_CENTER_TIMELINES.url(epochAt)] = epochTimelines
  const fetcher: SourceFetcher = async (s) =>
    EPOCH[s.url] ? ok(EPOCH[s.url]!) : { ok: false, status: 404, detail: 'HTTP 404' }
  await runRecipes(db, { raw: { put: async () => {} }, fetcher, now: () => epochAt }, [
    EPOCH_DATA_CENTERS,
    EPOCH_DATA_CENTER_TIMELINES,
  ])
  await seedHandTies(db)
})

beforeEach(async () => {
  stored.clear()
  for (const t of [
    schema.gridLoadDays,
    schema.gridLoadFiles,
    schema.ercotLargeLoadFacts,
    schema.ercotLargeLoadReports,
    schema.opsEvents,
  ]) {
    await db.delete(t)
  }
})

describe('the EIA-930 run', () => {
  const NOW = new Date('2026-11-21T06:00:00Z')
  const calls: string[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(url)
    const etag = (init?.headers as Record<string, string>)['If-None-Match']
    if (etag === '"v1"') return new Response(null, { status: 304 })
    if (url === eia930FileUrl('2026H2')) {
      return new Response(EIA, { status: 200, headers: { etag: '"v1"' } })
    }
    return new Response('not found', { status: 404 })
  }) as typeof globalThis.fetch

  it('stores the days with the kept lines in R2, then skips an unchanged file', async () => {
    calls.length = 0
    const first = await runGridLoad(db, { put, fetch, userAgent: 'test', now: NOW })
    // 2026H2 read; the walk back stops at the first file that fails.
    expect(first.map((r) => [r.period, r.status])).toEqual([
      ['2026H2', 'read'],
      ['2026H1', 'failed'],
    ])
    const days = await db.select().from(schema.gridLoadDays)
    expect(days).toHaveLength(3)
    expect(days[0]).toMatchObject({
      source_url: eia930FileUrl('2026H2'),
      fetched_at: NOW.toISOString(),
    })
    expect(stored.has(days[0]!.raw_key)).toBe(true)
    const ops = await db.select().from(schema.opsEvents)
    expect(ops.map((o) => o.kind)).toEqual(['grid_load_read_failed'])

    const second = await runGridLoad(db, { put, fetch, userAgent: 'test', now: NOW })
    expect(second[0]).toMatchObject({ period: '2026H2', status: 'unchanged' })
  })
})

describe('the EIA-930 run with a key', () => {
  const NOW = new Date('2026-11-21T06:00:00Z')
  const KEY = 'k3y-for-the-test-0000000000000000000000'
  const API = fixtureText('fixtures/grid-load/eia-api-daily-central-2026-07-01.json')
  const seen: { url: string; key: string | undefined }[] = []
  const apiFetch = (fail: boolean) =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      seen.push({ url, key: (init?.headers as Record<string, string>)['X-Api-Key'] })
      if (url.startsWith('https://api.eia.gov/')) {
        if (fail) return new Response('{}', { status: 503 })
        // Every clock answers with the Central fixture; only its own authorities are kept.
        const zone = new URL(url).searchParams.get('facets[timezone][]')
        return new Response(zone === 'Central' ? API : '{"response":{"total":"0","data":[]}}', {
          status: 200,
        })
      }
      if (url === eia930FileUrl('2018H1') || url === eia930FileUrl('2018H2')) {
        return new Response(EIA, { status: 200 })
      }
      return new Response('', { status: 404 })
    }) as typeof globalThis.fetch

  it('reads 2019 on from the API, with the key in a header only, and 2018 from the files', async () => {
    seen.length = 0
    const r = await runGridLoad(db, {
      put,
      fetch: apiFetch(false),
      userAgent: 'test',
      now: NOW,
      apiKey: KEY,
    })
    expect(r.map((x) => [x.period, x.status])).toEqual([
      [API_PERIOD, 'read'],
      ['2018H1', 'read'],
      ['2018H2', 'read'],
    ])
    const api = seen.filter((s) => s.url.startsWith('https://api.eia.gov/'))
    expect(api).toHaveLength(3)
    expect(api.every((s) => s.key === KEY && !s.url.includes(KEY))).toBe(true)
    expect(
      seen
        .filter((s) => !s.url.startsWith('https://api.eia.gov/'))
        .every((s) => s.key === undefined),
    ).toBe(true)
    const days = await db.select().from(schema.gridLoadDays)
    const miso = days.find((d) => d.ba === 'MISO' && d.date === '2026-07-01')!
    expect(miso.source_url.startsWith('https://api.eia.gov/')).toBe(true)
    expect(JSON.stringify(days)).not.toContain(KEY)
    expect([...stored.values()].some((b) => typeof b === 'string' && b.includes(KEY))).toBe(false)
  })

  it('falls back to the files when the API fails, and says so', async () => {
    const r = await runGridLoad(db, {
      put,
      fetch: apiFetch(true),
      userAgent: 'test',
      now: NOW,
      apiKey: KEY,
    })
    expect(r[0]).toMatchObject({ period: API_PERIOD, status: 'failed' })
    expect(r[1]!.period).toBe('2026H2')
    const ops = await db.select().from(schema.opsEvents)
    expect(ops[0]!.detail).toContain('reading the six-month files instead')
    expect(ops.some((o) => (o.detail ?? '').includes(KEY))).toBe(false)
  })
})

describe('the ERCOT run and the payload', () => {
  const NOW = new Date('2026-11-21T06:00:00Z')
  const listing = `<a href="${OVERVIEW_URL}">July</a><a href="${MONTHLY_URL}">April</a>`
  const fetcher: SourceFetcher = async (s) =>
    s.url.includes('/committees/board') && !s.url.endsWith('/2025')
      ? ok(listing)
      : s.url.endsWith('/news/presentations')
        ? ok(listing)
        : ok('')
  const fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === OVERVIEW_URL) return new Response(OVERVIEW, { status: 200 })
    if (url === MONTHLY_URL) return new Response(MONTHLY, { status: 200 })
    return new Response('', { status: 404 })
  }) as typeof globalThis.fetch

  it('reads each report once and keeps its bytes', async () => {
    const r = await runErcotLargeLoads(db, { fetcher, put, fetch, userAgent: 'test', now: NOW })
    expect(r.read.map((x) => [x.status, x.facts])).toEqual([
      ['read', 2],
      ['read', 3],
    ])
    expect([...stored.keys()].every((k) => k.startsWith('grid-load/ercot/'))).toBe(true)
    const again = await runErcotLargeLoads(db, { fetcher, put, fetch, userAgent: 'test', now: NOW })
    expect(again.read).toEqual([])
  })

  it('places each lab site in an authority and attaches its tickers', async () => {
    await runErcotLargeLoads(db, { fetcher, put, fetch, userAgent: 'test', now: NOW })
    const rows = ['ERCO', 'MISO', 'PJM', 'NYIS', 'AZPS'].flatMap((ba) =>
      Array.from({ length: 400 }, (_, i) => ({
        ba,
        date: new Date(Date.UTC(2025, 9, 1) + i * 86_400_000).toISOString().slice(0, 10),
        mwh: 24_000 + i,
        hours: 24,
        raw_key: 'k',
        first_seen_at: NOW.toISOString(),
        source_url: eia930FileUrl('2026H2'),
        fetched_at: NOW.toISOString(),
      })),
    )
    // D1 binds at most 100 parameters a statement: 12 rows of 8 columns.
    for (let i = 0; i < rows.length; i += 12) {
      await db.insert(schema.gridLoadDays).values(rows.slice(i, i + 12))
    }
    const data = await queryGridLoad(db)
    const area = (ba: string) => data.areas.find((a) => a.ba === ba)
    expect(area('ERCO')?.sites.map((s) => s.site)).toEqual(
      expect.arrayContaining(['OpenAI Stargate Abilene', 'Anthropic Barber Lake']),
    )
    expect(area('ERCO')?.sites.every((s) => s.basis === 'grid')).toBe(true)
    expect(area('ERCO')?.tickers.map((t) => t.ticker)).toEqual(
      expect.arrayContaining(['GEV', 'CIFR']),
    )
    expect(area('MISO')?.tickers.map((t) => t.ticker)).toEqual(
      expect.arrayContaining(['DTE', 'WEC', 'ETR']),
    )
    expect(area('PJM')?.tickers.map((t) => t.ticker)).toContain('AEP')
    expect(area('AZPS')?.tickers.map((t) => t.ticker)).toContain('PNW')
    const viaUtility = area('MISO')!.sites.find((s) => s.basis === 'utility')!
    expect(viaUtility.source_url).toBe(GRID_AREA_TABLE.source_url)
    expect(GRID_AREA_TABLE.utilities.map((u) => u.row)).toContain(viaUtility.quote)
    // A whole month past its first year carries a change on the year before.
    expect(area('ERCO')!.latest?.yoy).not.toBeNull()
    expect(data.ercot.months.map((m) => m.period)).toEqual(['2025-07'])
    expect(data.ercot.queue[0]).toMatchObject({ value_mw: 445800, horizon: '2033' })
    // Every authority shown is one EIA-930 is read for.
    expect(data.areas.every((a) => GRID_AREAS.some((g) => g.ba === a.ba))).toBe(true)
    expect(data.unplaced.map((u) => u.site)).toContain('Meta Prometheus')
  })

  it('loads the registered series for the harness: changes on a year before, and first-stated ERCOT months', async () => {
    await runErcotLargeLoads(db, { fetcher, put, fetch, userAgent: 'test', now: NOW })
    const rows = Array.from({ length: 800 }, (_, i) => ({
      ba: 'PJM',
      date: new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
      // 10% more load each day of the second year than the same day of the first.
      mwh: i < 366 ? 24_000 : 26_400,
      hours: 24,
      raw_key: 'k',
      first_seen_at: NOW.toISOString(),
      source_url: eia930FileUrl('2026H2'),
      fetched_at: NOW.toISOString(),
    }))
    for (let i = 0; i < rows.length; i += 12) {
      await db.insert(schema.gridLoadDays).values(rows.slice(i, i + 12))
    }
    const load = createLoader({ db, ctx: queryContext(fixtureText('sources.yaml'), null, NOW) })
    const source = (id: string) => SIGNALS.find((s) => s.id === id)!.source
    const monthly = await load(source('grid-load-pjm-monthly-yoy'))
    expect(monthly.kind).toBe('points')
    if (monthly.kind !== 'points') return
    expect(monthly.points[0]).toEqual({ date: '2025-01-01', value: expect.closeTo(0.1, 6) })
    const weekly = await load(source('grid-load-pjm-weekly-yoy'))
    expect(weekly.kind === 'points' && weekly.points.length).toBeGreaterThan(40)
    const observed = await load(source('ercot-large-load-observed'))
    expect(observed).toEqual({ kind: 'points', points: [{ date: '2025-07-01', value: 3820 }] })
  })
})
