import { describe, expect, test } from 'vitest'

import { VendorMdPricingOutput, contentHash, type PriceRow } from '../../server/pipeline/contracts'
import { eraById } from '../../server/pipeline/archive/eras'
import { fixtureProvenance } from '../../server/pipeline/parsers/fixture-provenance'
import { fixtureText } from './fixtures'

// Golden tests for the archived-page parsers (archive/eras.ts): one Internet
// Archive capture per era, trimmed as fixtures/manifest.json says, with its
// provenance from the manifest. Every era is also run twice to hold it to the
// determinism promise the live parsers keep (contracts/registry.ts).

/** A committed capture under fixtures/pricing/wayback/. */
const W = (name: string) => fixtureText(`fixtures/pricing/wayback/${name}`)

const FIXTURES = [
  ['openai-pricing-2023', '20230713090946', W('openai-pricing-2023-07.html')],
  ['openai-pricing-2023', '20240425015034', W('openai-pricing-2024-04.html')],
  ['openai-api-pricing-2024', '20241212110340', W('openai-api-pricing-2024-12.html')],
  ['openai-docs-pricing-2026', '20260304030314', W('openai-docs-pricing-2026-03.html')],
  ['openai-pricing-md-2026', '20260729122800', W('openai-pricing-2026-07.md')],
  ['anthropic-models-2024c', '20240620143535', W('anthropic-models-2024-06.html')],
  ['anthropic-pricing-docs-2025', '20250610103300', W('anthropic-pricing-2025-06.html')],
] as const

function parse(era: string, timestamp: string, text: string) {
  const prov = fixtureProvenance(`wayback-${era}-${timestamp}`)
  return { prov, out: eraById(era)!.parse(text, prov) }
}

const find = (rows: readonly PriceRow[], slug: string, tier: string | null = null) => {
  const row = rows.find((r) => r.model_slug === slug && r.tier === tier)
  if (!row) throw new Error(`no row ${slug} ${tier}`)
  return row
}
const prices = (r: PriceRow) => [r.input_per_mtok, r.cached_input_per_mtok, r.output_per_mtok]

describe('archived pricing pages', () => {
  test.each(FIXTURES)('%s %s is deterministic, valid, and cites its capture', (era, ts, text) => {
    const { prov, out } = parse(era, ts, text)
    expect(VendorMdPricingOutput.safeParse({ rows: out.rows }).success).toBe(true)
    expect(contentHash(parse(era, ts, text).out)).toBe(contentHash(out))
    expect(prov.source_url).toContain(`/web/${ts}id_/`)
    expect(
      out.rows.every((r) => r.source_url === prov.source_url && r.fetched_at === prov.fetched_at),
    ).toBe(true)
  })

  test('openai.com/pricing, July 2023: per-1K prices, SKUs printed by context length', () => {
    const { out } = parse('openai-pricing-2023', '20230713090946', W('openai-pricing-2023-07.html'))
    // "| 8K context | $0.03 / 1K tokens | $0.06 / 1K tokens |" under GPT-4
    expect(out.rows.map((r) => [r.model_slug, ...prices(r)])).toEqual([
      ['gpt-3.5-turbo', 1.5, null, 2],
      ['gpt-3.5-turbo-16k', 3, null, 4],
      ['gpt-4', 30, null, 60],
      ['gpt-4-32k', 60, null, 120],
    ])
    expect(find(out.rows, 'gpt-4').notes).toBe('printed as "8K context" under GPT-4')
  })

  test('openai.com/pricing, April 2024: per-1M prices by model id, older models included', () => {
    const { out } = parse('openai-pricing-2023', '20240425015034', W('openai-pricing-2024-04.html'))
    expect(out.rows).toHaveLength(12)
    expect(prices(find(out.rows, 'gpt-4-turbo-2024-04-09'))).toEqual([10, null, 30])
    expect(prices(find(out.rows, 'gpt-3.5-turbo-0125'))).toEqual([0.5, null, 1.5])
    expect(prices(find(out.rows, 'gpt-3.5-turbo-16k-0613'))).toEqual([3, null, 4])
    // Embeddings, fine-tuning, images and audio are not the token price list.
    expect(out.rows.some((r) => r.model_slug.startsWith('text-embedding'))).toBe(false)
  })

  test('openai.com/api/pricing, December 2024: standard, cached and Batch API prices', () => {
    const { out } = parse(
      'openai-api-pricing-2024',
      '20241212110340',
      W('openai-api-pricing-2024-12.html'),
    )
    expect(out.rows).toHaveLength(32)
    // "gpt-4o $2.50 / 1M input tokens $1.25 / 1M input tokens $1.25 / 1M cached** input tokens $10.00 … $5.00 …"
    expect(prices(find(out.rows, 'gpt-4o'))).toEqual([2.5, 1.25, 10])
    expect(prices(find(out.rows, 'gpt-4o', 'batch'))).toEqual([1.25, null, 5])
    expect(prices(find(out.rows, 'gpt-4o-2024-05-13'))).toEqual([5, null, 15])
    expect(prices(find(out.rows, 'o1-preview'))).toEqual([15, 7.5, 60])
    expect(prices(find(out.rows, 'gpt-4-32k'))).toEqual([60, null, 120])
    // Audio-preview rows price text and audio separately: passed over, and named.
    expect(out.passed).toEqual([
      'gpt-4o-audio-preview (priced per modality)',
      'gpt-4o-audio-preview-2024-10-01 (priced per modality)',
    ])
    expect(out.rows.some((r) => r.model_slug.includes('audio'))).toBe(false)
  })

  test('developers.openai.com/api/docs/pricing, March 2026: one Text tokens table per tier tab', () => {
    const { out } = parse(
      'openai-docs-pricing-2026',
      '20260304030314',
      W('openai-docs-pricing-2026-03.html'),
    )
    const tiers = new Map<string | null, number>()
    for (const r of out.rows) tiers.set(r.tier, (tiers.get(r.tier) ?? 0) + 1)
    expect([...tiers.entries()].sort()).toEqual([
      [null, 51],
      ['batch', 27],
      ['flex', 7],
      ['priority', 17],
    ])
    expect(prices(find(out.rows, 'gpt-5.2'))).toEqual([1.75, 0.175, 14])
    expect(prices(find(out.rows, 'gpt-5.2', 'priority'))).toEqual([3.5, 0.35, 28])
    // "-" is a price the tier doesn't offer.
    expect(prices(find(out.rows, 'gpt-5.2-pro', 'batch'))).toEqual([10.5, null, 84])
  })

  test('developers.openai.com/api/docs/pricing.md, July 2026: the markdown before its redesign', () => {
    const { out } = parse(
      'openai-pricing-md-2026',
      '20260729122800',
      W('openai-pricing-2026-07.md'),
    )
    expect(out.rows).toHaveLength(141)
    expect(prices(find(out.rows, 'gpt-5.6-sol'))).toEqual([5, 0.5, 30])
    expect(find(out.rows, 'gpt-5.6-sol', 'long_context')).toMatchObject({
      input_per_mtok: 10,
      output_per_mtok: 45,
      notes: 'long context',
    })
    expect(find(out.rows, 'gpt-5.5')).toMatchObject({
      notes: 'short context: <272K context length',
    })
    // Priority prints short-context columns only.
    expect(prices(find(out.rows, 'gpt-5.6-sol', 'priority'))).toEqual([10, 1, 60])
    expect(out.rows.some((r) => r.tier === 'priority_long_context')).toBe(false)
  })

  test('docs.anthropic.com models overview, June 2024: cost rows, math-rendered cells undone', () => {
    const { out } = parse(
      'anthropic-models-2024c',
      '20240620143535',
      W('anthropic-models-2024-06.html'),
    )
    // Haiku's cell was rendered as KaTeX ("0.25/" then "1.25"); its TeX source is "$0.25 / $1.25".
    expect(out.rows.map((r) => [r.model_slug, r.input_per_mtok, r.output_per_mtok])).toEqual([
      ['claude-2', 8, 24],
      ['claude-2-1', 8, 24],
      ['claude-haiku-3', 0.25, 1.25],
      ['claude-instant-1-2', 0.8, 2.4],
      ['claude-opus-3', 15, 75],
      ['claude-sonnet-3', 3, 15],
    ])
  })

  test('docs.anthropic.com pricing, June 2025: the live parser over the page’s own tables', () => {
    const { out } = parse(
      'anthropic-pricing-docs-2025',
      '20250610103300',
      W('anthropic-pricing-2025-06.html'),
    )
    expect(find(out.rows, 'claude-opus-4')).toMatchObject({
      input_per_mtok: 15,
      cached_input_per_mtok: 1.5,
      output_per_mtok: 75,
    })
    expect(prices(find(out.rows, 'claude-haiku-3-5', 'batch'))).toEqual([0.4, null, 2])
    // The same key the live pricing.md writes for this model.
    expect(prices(find(out.rows, 'claude-sonnet-3-7'))).toEqual([3, 0.3, 15])
  })
})
