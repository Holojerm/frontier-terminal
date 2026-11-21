// The Databento closes are licensed for internal use. These tests hold the
// line: no export, route, MCP tool, page or bulk file reads market_bars, and
// what the harness publishes carries no price.

import { beforeAll, describe, expect, it } from 'vitest'

import sourcesYaml from '~~/sources.yaml?raw'
import { SURFACE_WAIVERS } from '~~/surfaces.waivers'
import { addDays } from '../server/signals/market'
import { runSignals } from '../server/signals/run'
import { SIGNALS } from '../server/signals/registry'
import { EXPORT_TABLES } from '#server/registries/export-tables'

const PRIVATE_TABLES = ['market_bars', 'market_fetches']

// Every source file that could serve a request, as text.
const SOURCES = import.meta.glob(
  [
    '/server/**/*.ts',
    '/app/**/*.{ts,vue}',
    '/layers/*/server/**/*.ts',
    '/layers/*/app/**/*.{ts,vue}',
    '/layers/*/shared/**/*.ts',
    '/shared/**/*.ts',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>

/** The only files allowed to read the closes: the ingestion, the harness, its task, the table. */
const ALLOWED = new Set([
  '/layers/signals/server/db/tables/signals.ts',
  '/layers/signals/server/signals/market.ts',
  '/layers/signals/server/signals/harness.ts',
  '/layers/signals/server/signals/run.ts',
  '/layers/signals/server/tasks/signals/prices.ts',
])

describe('market prices stay private', () => {
  it('has no export of the closes or their fetch log', () => {
    for (const name of PRIVATE_TABLES) expect(Object.keys(EXPORT_TABLES)).not.toContain(name)
    for (const name of PRIVATE_TABLES) {
      expect(SURFACE_WAIVERS.export[name as keyof typeof SURFACE_WAIVERS.export]).toMatch(
        /^internal:/,
      )
    }
  })

  it('reads market_bars only from the ingestion and the harness', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(200)
    // Code only: a comment may name the table to say it is never read.
    const code = (text: string) =>
      text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const readers = Object.entries(SOURCES)
      .filter(([, text]) =>
        /marketBars|market_bars|signals\/market'|readPanel|buildPanel/.test(code(text)),
      )
      .map(([path]) => path)
      .filter((path) => !path.includes('/migrations/'))
    expect(readers.filter((p) => !ALLOWED.has(p))).toEqual([])
    expect(readers.length).toBeGreaterThan(0)
  })

  describe('the published statistics', () => {
    // Closes no statistic could produce by chance, so a leak is a string match.
    const CLOSE = (i: number) => 1000 + i * 0.123457 + 0.000_003
    const TICK = SIGNALS[0]!.tickers[0]!

    beforeAll(async () => {
      const rows: (typeof schema.marketBars.$inferInsert)[] = []
      let date = '2025-01-06'
      for (let i = 0; i < 400; i++) {
        for (const symbol of ['SPY', TICK]) {
          rows.push({
            symbol,
            date,
            close: symbol === 'SPY' ? 500 + i * 0.5 : CLOSE(i),
            volume: 1,
            dataset: 'EQUS.SUMMARY',
            fetched_at: '2026-11-20T07:00:00Z',
          })
        }
        date = addDays(date, 1)
      }
      for (let i = 0; i < rows.length; i += 14) {
        await db.insert(schema.marketBars).values(rows.slice(i, i + 14))
      }
      const ctx = queryContext(sourcesYaml, null, () => new Date('2026-11-21T07:10:00Z'))
      await runSignals(db, {
        ctx,
        now: () => new Date('2026-11-21T07:10:00Z'),
        id: 'run-private',
        appUrl: 'https://example.test',
      })
    })

    it('carries no close, in the API payload or the export', async () => {
      const ctx = queryContext(sourcesYaml, null, () => new Date('2026-11-21T07:10:00Z'))
      const payload = JSON.stringify(await querySignals(db, ctx))
      const exported = JSON.stringify(await db.select().from(schema.signalResults))
      for (let i = 0; i < 400; i++) {
        const close = CLOSE(i).toString()
        expect(payload.includes(close), close).toBe(false)
        expect(exported.includes(close), close).toBe(false)
      }
      expect(payload).not.toMatch(/"(close|price|bars|returns)"/)
      expect(payload).toContain('"prices_through":"2026-02-09"')
    })
  })
})
