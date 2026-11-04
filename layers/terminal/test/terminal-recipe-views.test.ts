import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeAll, describe, expect, it } from 'vitest'

import epochSites from '~~/fixtures/recipes/epoch-data-centers.csv?raw'
import limitsMeta from '~~/fixtures/recipes/limits-meta.md?raw'
import payAnthropic from '~~/fixtures/recipes/pay-anthropic.json?raw'
import ramp from '~~/fixtures/recipes/ramp-ai-index.html?raw'
import msft from '~~/fixtures/recipes/sec-msft-openai.xml?raw'
import * as schema from '~~/server/db/schema'
import type { SourceFetcher } from '../server/pipeline/fetch'
import { EPOCH_DATA_CENTERS } from '../server/theses/recipes/epoch-data-centers'
import { INVESTEE_RECIPES } from '../server/theses/recipes/investee-facts'
import { PAY_RECIPES } from '../server/theses/recipes/pay-bands'
import { RAMP_AI_INDEX } from '../server/theses/recipes/ramp-ai-index'
import { RATE_LIMIT_RECIPES } from '../server/theses/recipes/rate-limits'
import { runRecipes } from '../server/theses/recipes/run'
import {
  queryAdoption,
  queryDataCenters,
  queryLimits,
  queryParents,
  queryPay,
} from '../server/utils/terminal-recipe-views'
import { fixtureText } from './pipeline/fixtures'

// The panels' read side over a store the recipe runner filled from the
// committed fixtures: the numbers a page shows are the sources' own.

const db = drizzle(env.DB, { schema })
const NOW = new Date('2026-11-04T12:00:00Z')
const raw = { put: async (key: string, body: string) => void (await env.BLOB.put(key, body)) }
const ok = (text: string) => ({ ok: true as const, status: 200, text, bytes: text.length })

const BODIES: Record<string, string> = {
  'https://ramp.com/data/ai-index': ramp,
  'https://dev.meta.ai/docs/pricing-rate-limits.md': limitsMeta,
  'https://boards-api.greenhouse.io/v1/boards/anthropic/jobs?content=true&pay_transparency=true':
    payAnthropic,
  'https://data.sec.gov/submissions/CIK0000789019.json': fixtureText(
    'fixtures/sec/edgar-submissions-msft.json',
  ),
  'https://www.sec.gov/Archives/edgar/data/789019/000119312526323660/msft-20260630_htm.xml': msft,
  'https://epoch.ai/data/data_centers/data_centers.csv': epochSites,
}
const fetcher: SourceFetcher = async (s) =>
  BODIES[s.url] ? ok(BODIES[s.url]!) : { ok: false, status: 404, detail: 'HTTP 404' }

beforeAll(async () => {
  await runRecipes(db, { raw, fetcher, now: () => NOW }, [
    RAMP_AI_INDEX,
    RATE_LIMIT_RECIPES.find((r) => r.id === 'limits-meta')!,
    PAY_RECIPES.find((r) => r.id === 'pay-anthropic')!,
    INVESTEE_RECIPES.find((r) => r.id === 'sec-msft-openai')!,
    EPOCH_DATA_CENTERS,
  ])
})

describe('recipe views', () => {
  it('adoption: Ramp by month, any-AI first, then vendors by their newest rate', async () => {
    const a = await queryAdoption(db)
    expect(a.ramp!.months.at(-1)).toBe('2026-09-01')
    expect(a.ramp!.series.map((s) => s.key).slice(0, 3)).toEqual(['overall', 'anthropic', 'openai'])
    expect(a.ramp!.series[1]!.values.at(-1)).toBe(43.77)
    expect(a.ramp!.release_seen).toBe('2026-11-04')
    // Packages with no rows yet are listed, with no window.
    expect(a.downloads.every((d) => d.last_28d === null)).toBe(true)
    expect(a.agent_prs.map((x) => x.lab)).toEqual(['anthropic', 'openai', 'google'])
  })

  it('limits: one row per model and tier, first snapshot unchanged', async () => {
    const { pages } = await queryLimits(db)
    expect(pages).toHaveLength(1)
    const meta = pages[0]!
    expect(meta).toMatchObject({ lab: 'meta', snapshot: '2026-11-04', previous: null, changed: 0 })
    expect(meta.metrics).toEqual(['RPM', 'TPM'])
    expect(meta.rows.find((r) => r.model === 'muse-voice-transcribe-1.0')!.text).toMatch(/streams/)
  })

  it('pay: the board’s cells in order', async () => {
    const { boards } = await queryPay(db)
    expect(boards[0]!.cells.map((c) => [c.key, c.median, c.n])).toEqual([
      ['all', 350_000, 535],
      ['research', 505_000, 59],
      ['swe', 405_000, 87],
    ])
  })

  it('parents: the newest filing’s facts, labelled as the parent’s', async () => {
    const { parents } = await queryParents(db)
    const m = parents[0]!
    expect(m).toMatchObject({ parent: 'Microsoft', lab: 'openai', period: '2026-09-30' })
    const gain = m.facts.find(
      (f) => f.key === 'NonoperatingIncomeExpense|3m' && f.date === '2026-09-30',
    )
    expect(gain).toMatchObject({
      label: 'Gain or loss recognized (other income)',
      value: 272_000_000,
      unit: 'usd',
    })
    expect(m.facts.find((f) => f.label === 'Stake')).toMatchObject({ value: 0.24, unit: 'pure' })
  })

  it('data centers: attributed by named users at #confident or #likely', async () => {
    const d = await queryDataCenters(db)
    expect(d.sites).toBe(96)
    expect(Math.round(d.total_mw)).toBe(15_078)
    const anthropic = d.labs.find((l) => l.lab === 'anthropic')!
    // Colossus 1 and 2 count for Anthropic as a user; the speculative Amazon sites do not.
    expect(anthropic.names).toContain('Colossus 2')
    expect(anthropic.names).not.toContain('Amazon Madison Mega Site')
    expect(d.speculative_only).toContain('google')
    expect(d.site_list[0]!.name).toBe('Anthropic-Amazon New Carlisle')
  })
})
