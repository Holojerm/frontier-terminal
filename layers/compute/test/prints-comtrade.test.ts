import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import type { FetchOutcome, SourceFetcher } from '#layers/core/server/utils/pipeline-fetch'
import {
  COMTRADE,
  comtradeAvailabilityUrl,
  comtradePreviewUrl,
  parseComtradeAvailability,
  parseComtradePreview,
} from '../server/prints/comtrade'
import { readComtrade } from '../server/prints/ingest'
import { storeObservations } from '../server/prints/store'
import { SIGNALS } from '#layers/signals/server/signals/registry'
import { createLoader } from '#layers/signals/server/signals/sources'
import { queryContext } from '#layers/core/server/utils/terminal-db'
import { readPrintSources } from '#layers/core/server/utils/terminal-sources'
import { queryPrints } from '../server/utils/terminal-prints'
import { fixtureText } from '#layers/core/test/pipeline/fixtures'

// UN Comtrade's Korea HS 8542 months on the committed bytes: getDA (four of
// its 156 months) and the preview for each. Then the reader against a fake
// fetcher, re-releases as vintages, the route's separate series, and the
// year-on-year change the signals loader derives point in time.

const db = drizzle(env.DB, { schema })
const f = (name: string) => fixtureText(`fixtures/prints/${name}`)
const DA = f('comtrade-getda-410.json')
const PERIODS = ['2013-01', '2014-01', '2024-12', '2025-12'] as const
const preview = (p: string) => f(`comtrade-preview-${p.replace('-', '')}.json`)
const ok = (text: string): FetchOutcome => ({ ok: true, status: 200, text, bytes: text.length })

const releases = parseComtradeAvailability(DA)
const release = (p: string) => releases.find((r) => r.period === p)!

describe('parseComtradeAvailability', () => {
  it('reads each month with its first and last release in UTC', () => {
    expect(releases.map((r) => r.period)).toEqual([...PERIODS])
    expect(release('2014-01')).toEqual({
      period: '2014-01',
      classification: 'H4',
      first_released: '2014-08-06T19:53:27.000Z',
      last_released: '2025-06-12T07:03:51.000Z',
    })
  })

  it('throws on an error answer', () => {
    expect(() => parseComtradeAvailability('{"data":[],"error":"bad request"}')).toThrow()
  })
})

describe('parseComtradePreview', () => {
  it('reads the world total in USD, dated at the month’s last release', () => {
    expect(parseComtradePreview(preview('2025-12'), release('2025-12'))).toEqual({
      series: 'kr_hs8542_exports',
      entity: 'kr-semiconductors',
      ticker: null,
      period: '2025-12',
      window: 'month',
      value: 16_726_109_703,
      currency: 'USD',
      yoy_pct: null,
      observed_as: 'print',
      published_at: '2026-05-21T01:05:13.000Z',
      due_on: null,
    })
  })

  it('is null for a listed month with no row yet, and throws on the API’s refusals', () => {
    expect(parseComtradePreview('{"count":0,"data":[],"error":""}', release('2025-12'))).toBeNull()
    expect(() =>
      parseComtradePreview(
        '{"error":"Maximum number of periods for preview is 1","details":null}',
        release('2025-12'),
      ),
    ).toThrow(/periods/)
    // Another month's row is not this month's figure.
    expect(() => parseComtradePreview(preview('2024-12'), release('2025-12'))).toThrow()
  })
})

// ── the reader ───────────────────────────────────────────────────────────

const routes = new Map<string, string>([[comtradeAvailabilityUrl(), DA]])
for (const p of PERIODS) routes.set(comtradePreviewUrl(p), preview(p))
const requested: string[] = []
const fetcherOf =
  (map: Map<string, string>): SourceFetcher =>
  async (source) => {
    requested.push(source.url)
    const body = map.get(source.url)
    return body === undefined ? { ok: false, status: 404, detail: 'HTTP 404' } : ok(body)
  }
const sleeps: number[] = []
const deps = (fetcher: SourceFetcher) => ({
  raw: { put: async () => {} },
  fetcher,
  now: new Date('2026-11-21T14:41:00Z'),
  sleep: async (ms: number) => void sleeps.push(ms),
})

beforeEach(async () => {
  requested.length = 0
  sleeps.length = 0
  for (const table of [schema.hardwarePrints, schema.printDocuments, schema.opsEvents]) {
    await db.delete(table)
  }
})

describe('readComtrade', () => {
  it('reads each month once, oldest first, spaced, and nothing on the next run', async () => {
    expect(await readComtrade(db, deps(fetcherOf(routes)))).toEqual({
      listed: 4,
      read: 4,
      added: 4,
      revised: 0,
      pending: 0,
    })
    expect(requested).toEqual([comtradeAvailabilityUrl(), ...PERIODS.map(comtradePreviewUrl)])
    expect(sleeps).toHaveLength(3)
    const rows = await db.select().from(schema.hardwarePrints)
    expect(
      rows.map((r) => [r.period, r.value, r.published_at, r.basis, r.source_id]).sort(),
    ).toEqual([
      ['2013-01', 3_318_003_342, '2014-04-01T21:16:20.000Z', 'backfill', COMTRADE.source_id],
      ['2014-01', 3_819_829_297, '2025-06-12T07:03:51.000Z', 'backfill', COMTRADE.source_id],
      ['2024-12', 11_672_044_281, '2025-04-10T13:29:35.000Z', 'backfill', COMTRADE.source_id],
      ['2025-12', 16_726_109_703, '2026-05-21T01:05:13.000Z', 'backfill', COMTRADE.source_id],
    ])
    expect(rows.every((r) => r.raw_key?.startsWith('prints/comtrade/410-8542-'))).toBe(true)

    requested.length = 0
    expect(await readComtrade(db, deps(fetcherOf(routes)))).toMatchObject({ read: 0, added: 0 })
    expect(requested).toEqual([comtradeAvailabilityUrl()])
  })

  it('reads a re-released month again: a new figure is the next vintage, the same one no row', async () => {
    await readComtrade(db, deps(fetcherOf(routes)))
    const da = JSON.parse(DA) as { data: { period: number; lastReleased: string }[] }
    for (const r of da.data)
      if (r.period === 202412 || r.period === 202512) r.lastReleased = '2026-11-20T03:00:00.0'
    const rerelease = JSON.stringify(da)
    const revised = new Map(routes)
    revised.set(comtradeAvailabilityUrl(), rerelease)
    revised.set(
      comtradePreviewUrl('2025-12'),
      preview('2025-12').replaceAll('16726109703.0', '16800000000.0'),
    )
    expect(await readComtrade(db, deps(fetcherOf(revised)))).toMatchObject({
      read: 2,
      added: 0,
      revised: 1,
    })
    const dec = await db
      .select()
      .from(schema.hardwarePrints)
      .where(eq(schema.hardwarePrints.period, '2025-12'))
    expect(dec.map((r) => [r.vintage, r.value, r.published_at, r.basis]).sort()).toEqual([
      [1, 16_726_109_703, '2026-05-21T01:05:13.000Z', 'backfill'],
      [2, 16_800_000_000, '2026-11-20T03:00:00.000Z', 'live'],
    ])
    // December 2024 came back unchanged: still one row, and its log holds the new release.
    expect(
      await db
        .select()
        .from(schema.hardwarePrints)
        .where(eq(schema.hardwarePrints.period, '2024-12')),
    ).toHaveLength(1)
    const [doc] = await db
      .select()
      .from(schema.printDocuments)
      .where(eq(schema.printDocuments.doc_id, 'comtrade:410:2024-12'))
    expect(doc?.detail).toBe('2026-11-20T03:00:00.000Z')
  })

  it('stops at a 429 and spools it', async () => {
    const limited: SourceFetcher = async (source) =>
      source.url === comtradeAvailabilityUrl()
        ? ok(DA)
        : { ok: false, status: 429, detail: 'HTTP 429' }
    expect(await readComtrade(db, deps(limited))).toMatchObject({ read: 1, added: 0 })
    const events = await db.select().from(schema.opsEvents)
    expect(events.map((e) => e.detail)).toEqual([`${COMTRADE.source_id}: HTTP 429`])
  })
})

describe('the route and the harness', () => {
  it('serves HS 8542 as its own series of the Korea entity, credited to UN Comtrade', async () => {
    await readComtrade(db, deps(fetcherOf(routes)))
    const data = await queryPrints(db, queryContext(fixtureText('sources.yaml'), null))
    const korea = data.series.filter((s) => s.entity.id === 'kr-semiconductors')
    expect(korea.map((s) => s.series)).toEqual(['kr_chip_exports', 'kr_hs8542_exports'])
    const hs = korea[1]!
    expect(hs.points.map((p) => p.period)).toEqual(['2025-12', '2024-12', '2014-01', '2013-01'])
    expect(hs.ties).toEqual([])
    expect(korea[0]!.points).toEqual([])
    expect(korea[0]!.ties.length).toBeGreaterThan(0)

    const source = readPrintSources(fixtureText('sources.yaml')).find(
      (s) => s.id === COMTRADE.source_id,
    )
    expect(source).toMatchObject({ rights: 'restricted', verdict: 'include' })
  })

  it('derives the change from the values, public at the later of the two releases', async () => {
    await readComtrade(db, deps(fetcherOf(routes)))
    const load = createLoader({ db, ctx: queryContext(fixtureText('sources.yaml'), null) })
    const signal = SIGNALS.find((s) => s.id === 'kr-hs8542-exports')!
    expect(signal.tickers).toEqual(['MU', 'NVDA'])
    const loaded = await load(signal.source)
    expect(loaded.kind).toBe('points')
    if (loaded.kind !== 'points') return
    expect(loaded.points.map((p) => [p.date, Number(p.value.toFixed(4)), p.available])).toEqual([
      ['2014-01-01', Number(((3_819_829_297 / 3_318_003_342 - 1) * 100).toFixed(4)), '2025-06-12'],
      [
        '2025-12-01',
        Number(((16_726_109_703 / 11_672_044_281 - 1) * 100).toFixed(4)),
        '2026-05-21',
      ],
    ])
  })

  it('takes the base as it stood when the month was public, not a later revision', async () => {
    const write = {
      source_id: COMTRADE.source_id,
      source_url: comtradePreviewUrl('2025-12'),
      raw_key: null,
      basis: 'backfill' as const,
    }
    const o = (period: string, value: number, published_at: string) => ({
      ...parseComtradePreview(preview('2025-12'), release('2025-12'))!,
      period,
      value,
      published_at,
    })
    await storeObservations(db, [o('2024-12', 100, '2025-04-10T00:00:00.000Z')], {
      ...write,
      fetched_at: '2026-11-21T00:00:00.000Z',
    })
    await storeObservations(db, [o('2025-12', 150, '2026-05-21T00:00:00.000Z')], {
      ...write,
      fetched_at: '2026-11-21T00:00:01.000Z',
    })
    // December 2024 revised after December 2025 was out.
    await storeObservations(db, [o('2024-12', 120, '2026-09-01T00:00:00.000Z')], {
      ...write,
      fetched_at: '2026-11-21T00:00:02.000Z',
    })
    const load = createLoader({ db, ctx: queryContext(fixtureText('sources.yaml'), null) })
    expect(await load(SIGNALS.find((s) => s.id === 'kr-hs8542-exports')!.source)).toEqual({
      kind: 'points',
      points: [{ date: '2025-12-01', value: 50, available: '2026-05-21' }],
    })
  })
})
