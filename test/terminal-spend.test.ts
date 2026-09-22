import { describe, expect, it } from 'vitest'

import type { RankingObservation } from '../server/utils/terminal-rankings'
import {
  matchSku,
  slugTokens,
  splitPermaslug,
  summarizeSpend,
  type SkuPrice,
} from '../server/utils/terminal-spend'

// The implied-spend join, as pure arithmetic over a handful of typed rows:
// the slug match between OpenRouter's permaslugs and the vendors' SKU
// slugs, the low/high range, coverage, and the labs it refuses to price.

const prov = {
  source_url: 'https://openrouter.ai/api/v1/datasets/rankings-daily',
  fetched_at: '2026-09-09T12:00:00Z',
}
const pprov = {
  source_url: 'https://platform.claude.com/docs/en/about-claude/pricing.md',
  fetched_at: '2026-09-09T06:00:00Z',
}

const sku = (
  provider: SkuPrice['provider'],
  model_slug: string,
  input: number | null,
  output: number | null,
  extra: Partial<SkuPrice> = {},
): SkuPrice => ({
  entity_key: `model:${provider}:${model_slug}${extra.tier ? `:${extra.tier}` : ''}`,
  provider,
  model_slug,
  tier: null,
  input_per_mtok: input,
  output_per_mtok: output,
  effective_from: null,
  ...pprov,
  ...extra,
})

const obs = (date: string, model_permaslug: string, total_tokens: number): RankingObservation => ({
  date,
  provider: splitPermaslug(model_permaslug)?.provider ?? 'other',
  model_permaslug,
  total_tokens,
  ...prov,
})

describe('slugTokens', () => {
  it.each([
    ['claude-4.5-haiku-20251001', 'claude-haiku-4-5'],
    ['gpt-5.6-sol-20260709', 'gpt-5.6-sol'],
    ['gpt-5-mini-2025-08-07', 'gpt-5-mini'],
    ['grok-4.6-20260810', 'grok-4.6'],
    ['gemini-2.5-flash-lite', 'gemini-2.5-flash-lite'],
    ['minimax-m2.7-20260318:free', 'minimax-m2.7'],
  ])('%s and %s read as one model', (a, b) => {
    expect(slugTokens(a)).toBe(slugTokens(b))
  })

  it('does not conflate a lite with its base or a pro with its preview', () => {
    expect(slugTokens('gemini-2.5-flash-lite')).not.toBe(slugTokens('gemini-2.5-flash'))
    expect(slugTokens('gemini-3.1-pro-preview')).not.toBe(slugTokens('gemini-3.1-pro'))
  })
})

describe('splitPermaslug', () => {
  it('maps the four vendor prefixes and nothing else', () => {
    expect(splitPermaslug('x-ai/grok-4.6-20260810')).toEqual({
      provider: 'xai',
      slug: 'grok-4.6-20260810',
      free: false,
    })
    expect(splitPermaslug('openai/gpt-oss-120b:free')).toEqual({
      provider: 'openai',
      slug: 'gpt-oss-120b:free',
      free: true,
    })
    expect(splitPermaslug('deepseek/deepseek-v4-pro-20260813')).toBeNull()
    expect(splitPermaslug('other')).toBeNull()
  })
})

describe('matchSku', () => {
  const catalog = [
    sku('anthropic', 'claude-haiku-4-5', null, null, {
      source_url: 'https://platform.claude.com/docs/en/models/overview.md',
    }),
    sku('anthropic', 'claude-haiku-4-5', 1, 5),
    sku('anthropic', 'claude-haiku-4-5', 0.5, 2.5, { tier: 'batch' }),
    sku('google', 'gemini-2.5-flash', 0.3, 2.5, { tier: 'standard' }),
    sku('google', 'gemini-2.5-flash', 0.6, 5, { tier: 'standard', effective_from: '2027-01-01' }),
  ]

  it('prefers the priced, standard-tier, current row when a slug is listed more than once', () => {
    expect(matchSku('anthropic', 'claude-4.5-haiku-20251001', catalog)!.entity_key).toBe(
      'model:anthropic:claude-haiku-4-5',
    )
    expect(matchSku('google', 'gemini-2.5-flash', catalog)).toMatchObject({
      input_per_mtok: 0.3,
      effective_from: null,
    })
  })

  it('never crosses labs and returns null for an unlisted slug', () => {
    expect(matchSku('openai', 'claude-4.5-haiku-20251001', catalog)).toBeNull()
    expect(matchSku('anthropic', 'claude-mythos-9', catalog)).toBeNull()
  })
})

describe('summarizeSpend', () => {
  const catalog = [
    sku('anthropic', 'claude-sonnet-5', 2, 10),
    sku('google', 'gemini-2.5-flash', 0.3, 2.5, { tier: 'standard' }),
    sku('openai', 'gpt-5.6-sol', null, null), // listed, no published price — OpenAI's page prints none
    sku('xai', 'grok-4.6', 2, 6, { tier: 'standard' }),
  ]
  const M = 1_000_000
  const rows = [
    obs('2026-09-08', 'anthropic/claude-sonnet-5-20260630', 10 * M),
    obs('2026-09-08', 'google/gemini-2.5-flash', 20 * M),
    obs('2026-09-08', 'google/gemma-4-31b-it-20260402', 5 * M), // unlisted
    obs('2026-09-08', 'openai/gpt-5.6-sol-20260709', 30 * M), // unpriced
    obs('2026-09-08', 'x-ai/grok-4.6-20260810:free', 1 * M), // free tier
    obs('2026-09-08', 'deepseek/deepseek-v4-pro-20260813', 40 * M), // other
    obs('2026-09-08', 'other', 4 * M),
    obs('2026-08-01', 'anthropic/claude-sonnet-5-20260630', 999 * M), // outside the window
    // Seven quiet days so the window (the newest seven present) excludes 08-01.
    ...['01', '02', '03', '04', '05', '06', '07'].map((d) => obs(`2026-09-${d}`, 'other', 0)),
  ]

  it('prices what it can, as a range, and names what it cannot', () => {
    const s = summarizeSpend(rows, catalog)
    expect(s.window).toEqual({ from: '2026-09-02', to: '2026-09-08' })
    // Tokens: every row in the window; other = deepseek + the aggregated row.
    expect(s.totals).toEqual({
      tokens: 110 * M,
      other_tokens: 44 * M,
      priced_tokens: 30 * M,
      spend_low: 10 * 2 + 20 * 0.3,
      spend_high: 10 * 10 + 20 * 2.5,
    })
    const by = Object.fromEntries(s.providers.map((p) => [p.provider, p]))
    expect(by.anthropic).toMatchObject({
      tokens: 10 * M,
      priced_tokens: 10 * M,
      coverage: 1,
      spend_low: 20,
      spend_high: 100,
    })
    expect(by.anthropic!.share_low).toBeCloseTo(20 / 26)
    expect(by.anthropic!.share_high).toBeCloseTo(100 / 150)
    expect(by.google).toMatchObject({ tokens: 25 * M, priced_tokens: 20 * M, coverage: 0.8 })
    expect(by.openai).toMatchObject({
      tokens: 30 * M,
      priced_tokens: 0,
      coverage: 0,
      share_low: 0,
      spend_low: 0,
    })
    expect(by.xai).toMatchObject({ tokens: 1 * M, priced_tokens: 0, coverage: 0 })
    // Token share is among the four labs' tokens (66M), dollars among priced ones.
    expect(by.openai!.token_share).toBeCloseTo(30 / 66)

    expect(s.excluded).toEqual([
      {
        provider: 'openai',
        display: 'OpenAI',
        reason: 'listed SKUs carry no published price on the vendor page',
      },
      { provider: 'xai', display: 'xAI', reason: 'no priced SKU matched' },
    ])
    expect(by.google!.models.map((m) => [m.model_permaslug, m.reason])).toEqual([
      ['google/gemini-2.5-flash', null],
      ['google/gemma-4-31b-it-20260402', 'unlisted'],
    ])
    expect(by.openai!.models[0]).toMatchObject({
      matched_key: 'model:openai:gpt-5.6-sol',
      reason: 'unpriced',
      spend_low: null,
    })
    expect(by.xai!.models[0]).toMatchObject({ reason: 'free', matched_key: null })
    expect(by.anthropic!.models[0]).toMatchObject({
      price_source_url: pprov.source_url,
      price_fetched_at: pprov.fetched_at,
    })
  })

  it('an empty store is an empty window, not a division by zero', () => {
    const s = summarizeSpend([], catalog)
    expect(s.window).toBeNull()
    expect(s.totals.spend_high).toBe(0)
    expect(s.providers.every((p) => p.share_low === null && p.coverage === null)).toBe(true)
    expect(s.excluded).toEqual([])
  })
})
