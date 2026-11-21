import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeAll, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import type { SourceFetcher } from '#layers/core/server/pipeline/fetch'
import { readNormalizedTrailing } from '../server/theses/download-signals'
import {
  CONTROL_INDEX_ID,
  DOWNLOAD_SERIES,
  controlIndex,
  normalizedSeries,
  readDownloadSeries,
  seriesById,
  shareSeries,
  trailingRatio,
  weeklyRatio,
  type DayRow,
} from '../../adoption/server/recipes/download-series'
import {
  NPM_CONTROL_RECIPES,
  NPM_HISTORY_FROM,
  NPM_LAB_RECIPES,
  extractDownloads,
  npmRange,
} from '../../adoption/server/recipes/npm-downloads'
import { RECIPES } from '#server/registries/recipes'
import { runRecipes } from '../../core/server/recipes/run'
import { queryAdoption } from '../../adoption/server/utils/terminal-adoption'
import { ANTHROPIC_THESIS } from '../server/theses/anthropic'

// The derived download series over a store the recipe runner filled with
// synthetic npm ranges: every package rides one registry-wide growth curve,
// so dividing by the controls must give back each package's own level.

const DAY_MS = 86_400_000
const dayOf = (d: string) => Date.parse(`${d}T00:00:00Z`) / DAY_MS
const dateOf = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10)

const OUTAGE = '2026-10-14'
/** 1.0 through June 2025, then registry-wide growth of 1% a day. */
/** The base weeks' mean weekday factor: five days at 1, two at 0.5. */
const W = 6 / 7
const growth = (d: string) => 1 + Math.max(0, dayOf(d) - dayOf('2025-06-30')) / 100
const weekday = (d: string) => ([0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()) ? 0.5 : 1)
const LEVEL: Record<string, number> = {
  react: 9_000_000,
  typescript: 15_000_000,
  express: 4_000_000,
  lodash: 8_000_000,
  axios: 6_000_000,
  openai: 3_000,
  '@anthropic-ai/sdk': 2_000,
  '@google/genai': 1_000,
  '@mistralai/mistralai': 200,
}
const downloads = (pkg: string, d: string) => {
  if (d === OUTAGE) return 0
  if (pkg === '@anthropic-ai/claude-agent-sdk' && d < '2025-09-29') return 0
  const own = pkg === '@anthropic-ai/sdk' && d >= '2026-09-01' ? 2 : 1
  return Math.round((LEVEL[pkg] ?? 500) * own * growth(d) * weekday(d))
}

const body = (url: string) => {
  const m = /range\/(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})\/(.+)$/.exec(url)!
  const [start, end, pkg] = [m[1]!, m[2]!, m[3]!]
  const days = []
  for (let n = dayOf(start); n <= dayOf(end); n++) {
    days.push({ downloads: downloads(pkg, dateOf(n)), day: dateOf(n) })
  }
  return JSON.stringify({ start, end, package: pkg, downloads: days })
}

const db = drizzle(env.DB, { schema })
const NOW = new Date('2026-11-21T06:00:00Z')
const raw = { put: async (key: string, b: string) => void (await env.BLOB.put(key, b)) }
const fetcher: SourceFetcher = async (s) => {
  const text = body(s.url)
  return { ok: true as const, status: 200, text, bytes: text.length }
}
const deps = { raw, fetcher, now: () => NOW }

// Two full recipe runs over 18 months of daily rows: well under a second locally,
// but past the default 10 s hook timeout on a loaded Workers Builds machine.
beforeAll(async () => {
  // Twice: a control's first run reads 540 days from 2025-05-13, its second the rest.
  await runRecipes(db, deps, [...NPM_CONTROL_RECIPES, ...NPM_LAB_RECIPES])
  await runRecipes(db, deps, [...NPM_CONTROL_RECIPES, ...NPM_LAB_RECIPES])
}, 120_000)

const row = (date: string, value: number, outage = false): DayRow => ({
  date,
  value,
  outage,
  source_url: 'https://api.npmjs.org/x',
  fetched_at: '2026-11-21T06:00:00Z',
})

describe('npm ranges', () => {
  it('flags a zero after the first download as an outage, and not one before it', () => {
    const obs = extractDownloads(
      JSON.stringify({
        package: 'p',
        downloads: [
          { day: '2026-01-01', downloads: 0 },
          { day: '2026-01-02', downloads: 5 },
          { day: '2026-01-03', downloads: 0 },
        ],
      }),
    )
    expect(obs.map((o) => o.payload)).toEqual([{}, {}, { outage: true }])
    expect(obs.map((o) => o.value)).toEqual([0, 5, 0])
  })

  it('re-reads the whole window, and walks a deep start in 540-day steps', () => {
    expect(npmRange(NOW, null)).toEqual({ start: '2025-05-30', end: '2026-11-20' })
    expect(npmRange(NOW, '2026-11-19')).toEqual({ start: '2025-05-30', end: '2026-11-20' })
    expect(npmRange(NOW, null, NPM_HISTORY_FROM)).toEqual({
      start: '2025-05-13',
      end: '2026-11-04',
    })
    expect(npmRange(NOW, '2026-11-03', NPM_HISTORY_FROM)).toEqual({
      start: '2025-05-30',
      end: '2026-11-20',
    })
  })
})

describe('derived series, pure', () => {
  const base = { from: '2026-01-01', to: '2026-01-20' }
  const days = Array.from({ length: 30 }, (_, i) => dateOf(dayOf('2026-01-01') + i))

  it('indexes the controls to their base, and cancels a shift they all share', () => {
    const shift = (d: string) => (d >= '2026-01-25' ? 1.5 : 1)
    const a = days.map((d) => row(d, 100 * shift(d)))
    const b = days.map((d) => row(d, 10 * shift(d), d === '2026-01-27'))
    const c = days.map((d) => row(d, 50 * shift(d)))
    const index = controlIndex([a, b, c], base)
    expect(index.find((p) => p.date === '2026-01-10')!.value).toBe(1)
    expect(index.find((p) => p.date === '2026-01-26')!.value).toBe(1.5)
    // A day one control is out is not indexed at all.
    expect(index.some((p) => p.date === '2026-01-27')).toBe(false)
    const lab = days.map((d) => row(d, 400 * shift(d)))
    const normalized = normalizedSeries(lab, index)
    expect(new Set(normalized.map((p) => p.value))).toEqual(new Set([400]))
  })

  it('gives each member its share on days every member has, summing to one', () => {
    const { shares, totals } = shareSeries(
      new Map([
        ['x', [row('2026-01-01', 30), row('2026-01-02', 10), row('2026-01-03', 0, true)]],
        ['y', [row('2026-01-01', 10), row('2026-01-02', 30), row('2026-01-03', 5)]],
      ]),
    )
    expect(shares.get('x')!.map((p) => p.value)).toEqual([0.75, 0.25])
    expect(shares.get('y')!.map((p) => p.value)).toEqual([0.25, 0.75])
    expect(totals.map((t) => t.value)).toEqual([40, 40])
  })

  it('reads weeks and windows as ratios of sums over the days both carry', () => {
    // 2026-01-05 is a Monday.
    const week = Array.from({ length: 7 }, (_, i) => dateOf(dayOf('2026-01-05') + i))
    const num = week.filter((d) => d !== '2026-01-07').map((d) => row(d, 20))
    const den = week.map((d) => ({ date: d, value: 2 }))
    expect(weeklyRatio(num, den, 7)).toEqual([{ week: '2026-01-05', days: 6, value: 70 }])
    const t = trailingRatio(num, den, 7, 5)
    expect(t.at(-1)).toMatchObject({ date: '2026-01-11', value: 70, num: 120, days: 6 })
    // The day left out still ends a window.
    expect(t.find((p) => p.date === '2026-01-07')).toBeUndefined()
    expect(trailingRatio(num, den, 3, 2).find((p) => p.date === '2026-01-08')!.value).toBe(30)
  })

  it('names every series once, apart from every recipe id', () => {
    const ids = DOWNLOAD_SERIES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    const recipes = new Set(RECIPES.map((r) => r.id))
    expect(ids.filter((id) => recipes.has(id))).toEqual([])
    expect(ids).toContain(CONTROL_INDEX_ID)
    expect(ids).toContain('npm-anthropic-sdk-normalized')
    expect(ids).toContain('npm-anthropic-sdk-share')
    expect(ids).toContain('pypi-anthropic-share')
    expect(ids).toContain('npm-wrangler-normalized')
  })
})

describe('derived series over the store', () => {
  it('reads the controls back to 2025-05-13 and flags the outage day', async () => {
    const s = await readDownloadSeries(db)
    expect(s.rows.get('npm-control-react')![0]!.date).toBe(NPM_HISTORY_FROM)
    expect(s.outage_days).toEqual([OUTAGE])
    expect(s.index.some((p) => p.date === OUTAGE)).toBe(false)
    // The agent SDK's zeros before it was published are not outages.
    expect(
      s.rows
        .get('npm-claude-agent-sdk')!
        .filter((r) => r.outage)
        .map((r) => r.date),
    ).toEqual([OUTAGE])
  })

  it('gives back each package’s own level once the registry’s growth is divided out', async () => {
    const s = await readDownloadSeries(db)
    const openai = seriesById(s, 'npm-openai-normalized')!
    expect(openai.at(-1)!.value).toBeCloseTo(3_000 * W, -1)
    expect(openai.find((p) => p.date === '2025-08-15')!.value).toBeCloseTo(3_000 * W, -1)
    // The SDK's own doubling stays.
    const sdk = seriesById(s, 'npm-anthropic-sdk-normalized')!
    expect(sdk.at(-1)!.value / sdk.find((p) => p.date === '2026-08-15')!.value).toBeCloseTo(2, 2)
    const share = seriesById(s, 'npm-anthropic-sdk-share')!
    expect(share.find((p) => p.date === '2026-08-15')!.value).toBeCloseTo(2 / 6.2, 3)
    expect(share.at(-1)!.value).toBeCloseTo(4 / 8.2, 3)
  })

  it('adoption: normalized and share beside the raw counts, the outage week partial', async () => {
    const a = await queryAdoption(db)
    const sdk = a.downloads.find((d) => d.recipe_id === 'npm-anthropic-sdk')!
    expect(sdk.series).toEqual({
      normalized: 'npm-anthropic-sdk-normalized',
      share: 'npm-anthropic-sdk-share',
    })
    expect(sdk.share_28d).toBeCloseTo(4 / 8.2, 3)
    expect(sdk.normalized_last_28d).toBeCloseTo(28 * 4_000 * W, -2)
    expect(sdk.normalized_prior_28d).toBeCloseTo(28 * 4_000 * W, -2)
    // Raw, the window rides the registry: far more than the 0% adjusted change.
    expect(sdk.last_28d! / sdk.prior_28d!).toBeGreaterThan(1.1)
    const outageWeek = '2026-10-12'
    expect(sdk.weekly.find((w) => w.week === outageWeek)).toMatchObject({ days: 6, partial: true })
    expect(sdk.normalized.find((w) => w.week === outageWeek)).toMatchObject({ days: 6 })
    const agent = a.downloads.find((d) => d.recipe_id === 'npm-claude-agent-sdk')!
    expect(agent.series.share).toBeNull()
    expect(agent.share).toEqual([])
    expect(a.controls.outage_days).toEqual([OUTAGE])
    expect(a.controls.packages.map((p) => p.package)).toEqual([
      'react',
      'typescript',
      'express',
      'lodash',
      'axios',
    ])
    expect(a.controls.index.find((w) => w.week === '2025-06-09')!.value).toBeCloseTo(1, 1)
  })

  it('claim 7 reads the normalized 28 days, with the raw sum in the detail', async () => {
    const spec = ANTHROPIC_THESIS.claims.find((c) => c.id === 'anthropic-sdk-downloads')!.spec
    if (spec.kind !== 'measured' || spec.signal !== 'npm-normalized-trailing-sum') throw new Error()
    const readings = await readNormalizedTrailing(db, spec)
    const newest = readings.at(-1)!
    expect(newest.date).toBe('2026-11-20')
    expect(newest.value).toBeCloseTo(28 * 4_000 * W, -2)
    const across = readings.find((r) => r.date === '2026-10-20')!
    expect(across.detail).toMatchObject({ days: 28, days_on_record: 27 })
  })
})
