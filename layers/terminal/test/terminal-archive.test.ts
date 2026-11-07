import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { HISTORY_LICENSE, PAID_LICENSE } from '#shared/utils/license'
import type { SourceFetcher } from '../server/pipeline/fetch'
import { ARCHIVE_ERAS } from '../server/pipeline/archive/eras'
import { archiveRows } from '../server/pipeline/archive/rows'
import { runRefresh, type RawStore } from '../server/pipeline/refresh'
import { includeSources } from '../server/pipeline/sources'
import { PointInTimeError, pollStampAt } from '../server/utils/terminal-asof'
import { terminalStamps } from '../server/utils/terminal-cache'
import { assertArchiveKnowable, queryPriceReach } from '../server/utils/terminal-archive'
import {
  queryContext,
  queryPriceHistory,
  queryPriceKeys,
  queryPrices,
} from '../server/utils/terminal-db'
import { exportTable, licenseWindow } from '../server/utils/terminal-export'
import { PROVIDER_ORDER } from '../server/utils/terminal-sources'
import { fixtureText, manifest } from './pipeline/fixtures'

// The archived price history on the read side: archived points before live
// ones on a SKU's page, an archive-only SKU, /api/prices as of an instant
// before our first fetch, the reach table, and the license an archived row
// carries whoever asks.

const POLLS = { timeout: 60_000 }
const db = drizzle(env.DB, { schema })
const sourcesYaml = fixtureText('sources.yaml')
const ALL = includeSources(sourcesYaml, manifest.fixtures)

const raw: RawStore = {
  put: async (key, body, contentType) => {
    await env.BLOB.put(key, body, { httpMetadata: { contentType } })
  },
}
const fetcher: SourceFetcher = async (source) => {
  const f = manifest.fixtures.find((x) => x.source_url === source.url)
  if (!f) throw new Error(`no fixture for ${source.url}`)
  const text = fixtureText(f.path)
  return { ok: true, status: 200, text, bytes: text.length }
}
let tick = Date.parse('2026-09-07T10:00:00Z')
const now = () => new Date((tick += 1000))
const poll = () =>
  runRefresh(
    { db, raw, fetcher, sourcesYaml, now },
    'survey',
    ALL.map((s) => s.source_id),
  )

const ERA = ARCHIVE_ERAS.find((e) => e.id === 'openai-pricing-2023')!
const FETCHED = '2026-11-04T00:00:00.000Z'
const page = (rows: [string, string, string][]) =>
  '<h3>GPT-4</h3><table><tr><td>Model</td><td>Input</td><td>Output</td></tr>' +
  rows
    .map(
      ([id, i, o]) => `<tr><td>${id}</td><td>${i} / 1K tokens</td><td>${o} / 1K tokens</td></tr>`,
    )
    .join('') +
  '</table></html>'

async function archive(timestamp: string, html: string) {
  const out = archiveRows(
    ERA,
    { timestamp, original: 'https://openai.com/pricing', digest: timestamp },
    html,
    html.length,
    FETCHED,
  )
  await db.insert(schema.archiveCaptures).values(out.capture)
  if (out.prices.length) await db.insert(schema.archivedPrices).values(out.prices)
}

const live = async () => queryContext(sourcesYaml, (await terminalStamps(db)).poll)
const asOf = async (at: string) =>
  queryContext(sourcesYaml, await pollStampAt(db, at), undefined, at)

// A key the live OpenAI fixture prices, so its archived points join a live series.
const LIVE_KEY = 'model:openai:gpt-4o'

beforeEach(async () => {
  // The tables are wiped below, so each test starts its clock again too.
  tick = Date.parse('2026-09-07T10:00:00Z')
  for (const table of [
    schema.sourceRuns,
    schema.sourceStats,
    schema.changes,
    schema.entities,
    schema.snapshots,
    schema.archiveCaptures,
    schema.archivedPrices,
  ]) {
    await db.delete(table)
  }
  await archive(
    '20230601000000',
    page([
      ['gpt-4-0314', '$0.03', '$0.06'],
      ['gpt-4o', '$0.005', '$0.015'],
    ]),
  )
  await archive(
    '20230701000000',
    page([
      ['gpt-4-0314', '$0.03', '$0.06'],
      ['gpt-4o', '$0.005', '$0.015'],
    ]),
  )
  await archive('20231201000000', page([['gpt-4o', '$0.0025', '$0.010']]))
  await archive('20231208000000', '<p>Just a moment…</p>')
})

describe('archived price history', () => {
  it('comes before the live points of the same SKU, labeled as archived', POLLS, async () => {
    await poll()
    const h = (await queryPriceHistory(db, await live(), LIVE_KEY))!
    const archived = h.points.filter((p) => p.basis === 'archived')
    expect(archived.map((p) => [p.at, p.input_per_mtok, p.source_id])).toEqual([
      ['2023-06-01T00:00:00.000Z', 5, 'wayback:openai-pricing-2023'],
      ['2023-12-01T00:00:00.000Z', 2.5, 'wayback:openai-pricing-2023'],
    ])
    expect(archived[0]!.source_url).toBe(
      'https://web.archive.org/web/20230601000000id_/https://openai.com/pricing',
    )
    expect(archived[0]!.fetched_at).toBe(FETCHED)
    const firstLive = h.points.findIndex((p) => p.basis === 'live')
    expect(firstLive).toBe(archived.length)
    expect(h.archive_only).toBe(false)
  })

  it('serves a SKU the archive alone priced, and lists it for the sitemap', POLLS, async () => {
    await poll()
    const h = (await queryPriceHistory(db, await live(), 'model:openai:gpt-4-0314'))!
    expect(h.archive_only).toBe(true)
    expect(h.provider).toBe('openai')
    expect(h.model_slug).toBe('gpt-4-0314')
    expect(h.points.map((p) => p.kind)).toEqual(['archived'])
    const keys = await queryPriceKeys(db)
    expect(keys).toContainEqual({
      entity_key: 'model:openai:gpt-4-0314',
      lastmod: '2023-07-01',
      history: true,
    })
  })

  it(
    'answers /api/prices before our first fetch from the newest readable capture',
    POLLS,
    async () => {
      await poll()
      const c = await asOf('2023-12-10T00:00:00.000Z')
      const prices = await queryPrices(db, c)
      expect(prices.rows.map((r) => [r.entity_key, r.input_per_mtok, r.source_id])).toEqual([
        ['model:openai:gpt-4o', 2.5, 'wayback:openai-pricing-2023'],
      ])
      expect(prices.matrix.cells.every((cell) => cell.row === null)).toBe(true)
      const method = [...c.notes.method].join(' ')
      expect(method).toContain('Internet Archive')
      expect(method).toContain('openai: Internet Archive capture of 2023-12-01T00:00:00.000Z')
      // gpt-4-0314 left the page between the two captures, so it is not in the list at T.
      const earlier = await queryPrices(db, await asOf('2023-07-15T00:00:00.000Z'))
      expect(earlier.rows.map((r) => r.entity_key)).toEqual([
        'model:openai:gpt-4-0314',
        'model:openai:gpt-4o',
      ])
    },
  )

  it(
    'answers a lab fetched later than the others from the archive up to its own first fetch',
    POLLS,
    async () => {
      const { registry } = await live()
      const openaiPricing = new Set(
        registry.sources
          .filter((s) => s.axis === 'pricing-catalog' && s.provider === 'openai')
          .map((s) => s.source_id),
      )
      const ids = ALL.map((s) => s.source_id)
      await runRefresh(
        { db, raw, fetcher, sourcesYaml, now },
        'survey',
        ids.filter((id) => !openaiPricing.has(id)),
      )
      // A capture after the store's first fetch, but before OpenAI's own.
      await archive('20260907120000', page([['gpt-4o', '$0.002', '$0.008']]))
      tick += 86_400_000
      await runRefresh({ db, raw, fetcher, sourcesYaml, now }, 'survey', [...openaiPricing])

      const c = await asOf('2026-09-07T13:00:00.000Z')
      const prices = await queryPrices(db, c)
      const openai = prices.rows.filter((r) => r.provider === 'openai')
      expect(openai.map((r) => [r.entity_key, r.input_per_mtok, r.source_id])).toEqual([
        ['model:openai:gpt-4o', 2, 'wayback:openai-pricing-2023'],
      ])
      expect(
        prices.rows.some((r) => r.provider === 'xai' && !r.source_id.startsWith('wayback:')),
      ).toBe(true)
      // The matrix is built from live rows only.
      expect(
        prices.matrix.cells.filter((cell) => cell.provider === 'openai').every((cell) => !cell.row),
      ).toBe(true)
      expect([...c.notes.method].join(' ')).toContain('some labs were added later')

      // The SKU's archived points run to OpenAI's first fetch, not the store's.
      const h = (await queryPriceHistory(db, await live(), LIVE_KEY))!
      expect(h.points.filter((p) => p.basis === 'archived').map((p) => p.at)).toContain(
        '2026-09-07T12:00:00.000Z',
      )
    },
  )

  it('refuses an instant before the earliest readable capture', async () => {
    await expect(assertArchiveKnowable(db, '2023-05-01T00:00:00.000Z')).rejects.toBeInstanceOf(
      PointInTimeError,
    )
    await expect(assertArchiveKnowable(db, '2023-06-02T00:00:00.000Z')).resolves.toBeUndefined()
  })

  it('reports how far each lab’s history reaches', POLLS, async () => {
    await poll()
    const { registry } = await live()
    const reach = await queryPriceReach(db, registry)
    expect(reach.find((r) => r.provider === 'openai')).toMatchObject({
      archived_from: '2023-06-01T00:00:00.000Z',
      archived_until: '2023-12-01T00:00:00.000Z',
      archived_parsed: 3,
      archived_skipped: 1,
    })
    expect(reach.find((r) => r.provider === 'openai')!.live_from).toMatch(/^2026-09-07T/)
    expect(reach.find((r) => r.provider === 'meta')!.not_covered).toContain('no API price list')
    // Every tracked lab has a row, the labs added on 2026-11-04 included.
    expect(reach.map((r) => r.provider)).toEqual(PROVIDER_ORDER)
  })

  it('keeps archived rows CC BY-NC even under a licensee’s key', () => {
    const table = exportTable('archived_prices')!
    const window = licenseWindow(
      'archived_prices',
      table,
      { history: 'full' },
      '2026-08-06',
      PAID_LICENSE,
    )
    expect(window.older).toBe(HISTORY_LICENSE)
    const live = licenseWindow(
      'changes',
      exportTable('changes')!,
      { history: 'full' },
      '2026-08-06',
      PAID_LICENSE,
    )
    expect(live.older).toBe(PAID_LICENSE)
  })
})
