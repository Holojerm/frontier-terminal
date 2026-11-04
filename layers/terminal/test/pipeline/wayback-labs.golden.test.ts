import { describe, expect, test } from 'vitest'

import { VendorMdPricingOutput, contentHash, type PriceRow } from '../../server/pipeline/contracts'
import { eraById } from '../../server/pipeline/archive/eras'
import { fixtureProvenance } from '../../server/pipeline/parsers/fixture-provenance'
import { fixtureText } from './fixtures'

// Golden tests for the archive eras added after the first backfill: the
// OpenAI windows it left open, and Google, xAI, Mistral, DeepSeek and
// Alibaba. One Internet Archive capture per shape, trimmed as
// fixtures/manifest.json says, provenance from the manifest, each era run
// twice for determinism (the same harness as wayback.golden.test.ts).

const W = (name: string) => fixtureText(`fixtures/pricing/wayback/${name}`)

const FIXTURES = [
  ['openai-api-pricing-2025', '20250128220305', 'openai-api-pricing-2025-01.html'],
  ['openai-docs-pricing-2026b', '20260308031250', 'openai-docs-pricing-2026-03b.html'],
  ['openai-docs-pricing-2026b', '20260717100803', 'openai-docs-pricing-2026-07.html'],
  ['google-pricing-2024', '20240615034357', 'google-pricing-2024-06.html'],
  ['google-pricing-2024', '20240812213720', 'google-pricing-2024-08.html'],
  ['google-pricing-2024', '20250113073052', 'google-pricing-2025-01.html'],
  ['google-docs-pricing-2025', '20250607103454', 'google-docs-pricing-2025-06.html'],
  ['google-docs-pricing-2025', '20250918150943', 'google-docs-pricing-2025-09.html'],
  ['xai-api-2025', '20250320104541', 'xai-api-2025-03.html'],
  ['xai-docs-models-2025', '20251202224031', 'xai-docs-models-2025-12.html'],
  ['xai-models-md-2026', '20260312220938', 'xai-models-2026-03.md'],
  ['xai-models-md-2026', '20260616001005', 'xai-models-2026-06.md'],
  ['mistral-docs-pricing-2023', '20240413034939', 'mistral-docs-pricing-2024-04.html'],
  ['mistral-technology-2024', '20240615101417', 'mistral-technology-2024-06.html'],
  ['mistral-technology-2024', '20250203181801', 'mistral-technology-2025-02.html'],
  ['deepseek-platform-pricing-2024', '20240525232726', 'deepseek-platform-pricing-2024-05.html'],
  ['deepseek-api-docs-pricing-2024', '20241226115837', 'deepseek-pricing-2024-12.html'],
  ['deepseek-api-docs-pricing-2024', '20250325062124', 'deepseek-pricing-2025-03.html'],
  ['deepseek-api-docs-pricing-2024', '20251201114852', 'deepseek-pricing-2025-12.html'],
  ['deepseek-api-docs-pricing-2024', '20260501050639', 'deepseek-pricing-2026-05.html'],
  ['deepseek-api-docs-pricing-2024', '20260816171438', 'deepseek-pricing-2026-08.html'],
  ['alibaba-model-pricing-2026', '20260116072901', 'alibaba-model-pricing-2026-01.html'],
  ['alibaba-model-pricing-2026', '20260811054610', 'alibaba-model-pricing-2026-08.html'],
] as const

function parse(era: string, timestamp: string, name: string) {
  const prov = fixtureProvenance(`wayback-${era}-${timestamp}`)
  return { prov, out: eraById(era)!.parse(W(name), prov) }
}

const find = (rows: readonly PriceRow[], slug: string, tier: string | null = null) => {
  const row = rows.find((r) => r.model_slug === slug && r.tier === tier)
  if (!row) throw new Error(`no row ${slug} ${tier}`)
  return row
}
const prices = (r: PriceRow) => [r.input_per_mtok, r.cached_input_per_mtok, r.output_per_mtok]

describe('archived pricing pages, second pass', () => {
  test.each(FIXTURES)('%s %s is deterministic, valid, and cites its capture', (era, ts, name) => {
    const { prov, out } = parse(era, ts, name)
    expect(VendorMdPricingOutput.safeParse({ rows: out.rows }).success).toBe(true)
    expect(contentHash(parse(era, ts, name).out)).toBe(contentHash(out))
    expect(prov.source_url).toContain(`/web/${ts}id_/`)
    expect(
      out.rows.every((r) => r.source_url === prov.source_url && r.fetched_at === prov.fetched_at),
    ).toBe(true)
  })
})

describe('OpenAI', () => {
  test('openai.com/api/pricing, late January 2025: each row opens on its own header', () => {
    const { out } = parse(
      'openai-api-pricing-2025',
      '20250128220305',
      'openai-api-pricing-2025-01.html',
    )
    expect(out.rows).toHaveLength(34)
    // "gpt-4o Pricing Pricing with Batch API* $2.50 / 1M input tokens $1.25 / 1M input tokens …"
    expect(prices(find(out.rows, 'gpt-4o'))).toEqual([2.5, 1.25, 10])
    expect(prices(find(out.rows, 'gpt-4o', 'batch'))).toEqual([1.25, null, 5])
    // "Other models": "gpt-4-turbo Input Output $10.00 / 1M tokens $30.00 / 1M tokens"
    expect(prices(find(out.rows, 'gpt-4-turbo'))).toEqual([10, null, 30])
    expect(prices(find(out.rows, 'o1-mini'))).toEqual([3, 1.5, 12])
    expect(out.passed).toContain('gpt-4o-audio-preview (priced per modality)')
  })

  test('openai.com/api/pricing: the misprinted o3-mini snapshot id is mapped and noted', () => {
    const html =
      '<div class="text-h5 m:hidden">OpenAI o3-mini<button aria-label="Expand feature group"></button></div>' +
      '<p>03-mini-2025-01-31 Pricing Pricing with Batch API*** $1.10 / 1M input tokens $0.55 / 1M input tokens' +
      ' $0.55 / 1M cached* input tokens $4.40 / 1M output** tokens $2.20 / 1M output** tokens</p></html>'
    const prov = fixtureProvenance('wayback-openai-api-pricing-2025-20250128220305')
    const out = eraById('openai-api-pricing-2025')!.parse(html, prov)
    expect(find(out.rows, 'o3-mini-2025-01-31')).toMatchObject({
      input_per_mtok: 1.1,
      cached_input_per_mtok: 0.55,
      output_per_mtok: 4.4,
      notes: 'printed as "03-mini-2025-01-31"',
    })
  })

  test('developers.openai.com pricing, March 2026: full tables, a long-context row of its own', () => {
    const { out } = parse(
      'openai-docs-pricing-2026b',
      '20260308031250',
      'openai-docs-pricing-2026-03b.html',
    )
    expect(out.rows).toHaveLength(112)
    expect(prices(find(out.rows, 'gpt-5.4'))).toEqual([2.5, 0.25, 15])
    // "gpt-5.4 (>272K context length) | $5.00 | $0.50 | $22.50" under Standard
    expect(find(out.rows, 'gpt-5.4', 'long_context')).toMatchObject({
      input_per_mtok: 5,
      output_per_mtok: 22.5,
      notes: 'long context: >272K context length',
    })
    // An empty cached-input cell prints no price.
    expect(prices(find(out.rows, 'gpt-5.4-pro'))).toEqual([30, null, 180])
  })

  test('developers.openai.com pricing, July 2026: every tier’s full list from its island props', () => {
    const { out } = parse(
      'openai-docs-pricing-2026b',
      '20260717100803',
      'openai-docs-pricing-2026-07.html',
    )
    expect(out.rows).toHaveLength(122)
    // The same prices the pricing.md twin printed twelve days later (wayback.golden.test.ts).
    expect(prices(find(out.rows, 'gpt-5.6-sol'))).toEqual([5, 0.5, 30])
    expect(prices(find(out.rows, 'gpt-5.6-sol', 'priority'))).toEqual([10, 1, 60])
    // Older models, only behind "View all": four cells, no cache-writes column.
    expect(prices(find(out.rows, 'gpt-5.2'))).toEqual([1.75, 0.175, 14])
    expect(prices(find(out.rows, 'gpt-4o-2024-05-13', 'priority'))).toEqual([8.75, null, 26.25])
    expect(find(out.rows, 'gpt-5.5').notes).toBe('short context: <272K context length')
  })
})

describe('Google', () => {
  test('ai.google.dev/pricing, June 2024: card prices by prompt length, short band read', () => {
    const { out } = parse('google-pricing-2024', '20240615034357', 'google-pricing-2024-06.html')
    // "Price (input) $0.35 / 1 million tokens (for prompts up to 128K tokens) $0.70 / 1 million tokens (…longer…)"
    expect(out.rows.map((r) => [r.model_slug, r.tier, ...prices(r)])).toEqual([
      ['gemini-1.5-flash', 'standard', 0.35, null, 1.05],
      ['gemini-1.5-pro', 'standard', 3.5, null, 10.5],
    ])
    expect(find(out.rows, 'gemini-1.5-flash', 'standard').notes).toContain(
      'Price (input): $0.35 up to 128K tokens, $0.70 longer',
    )
    // No id the page or its successor printed: named, not guessed.
    expect(out.passed).toEqual(['Gemini 1.0 Pro (no API id the page or its successor printed)'])
  })

  test('ai.google.dev/pricing, August 2024: the "<= 128K" band the HTML lost', () => {
    const { out } = parse('google-pricing-2024', '20240812213720', 'google-pricing-2024-08.html')
    expect(prices(find(out.rows, 'gemini-1.5-flash', 'standard'))).toEqual([0.075, 0.01875, 0.3])
    expect(prices(find(out.rows, 'gemini-1.5-pro', 'standard'))).toEqual([3.5, 0.875, 10.5])
  })

  test('ai.google.dev/pricing, January 2025: "Prompts up to 128k tokens" blocks', () => {
    const { out } = parse('google-pricing-2024', '20250113073052', 'google-pricing-2025-01.html')
    expect(out.rows).toHaveLength(3)
    expect(prices(find(out.rows, 'gemini-1.5-flash-8b', 'standard'))).toEqual([0.0375, 0.01, 0.15])
    expect(find(out.rows, 'gemini-1.5-pro', 'standard').notes).toContain(
      'longer prompts: input $2.50, output $10.00, context caching $0.625',
    )
  })

  test('ai.google.dev/pricing: a price not billed yet skips the capture', () => {
    const html =
      '<h2 id="gemini-1.5-flash">Gemini 1.5 Flash</h2><p>Pay-as-you-go Price (input) $0.35 / 1 million tokens' +
      ' Price (output) $1.05 / 1 million tokens Billing starts May 30, 2024</p></html>'
    const prov = fixtureProvenance('wayback-google-pricing-2024-20240615034357')
    expect(() => eraById('google-pricing-2024')!.parse(html, prov)).toThrow(
      'pay-as-you-go not billed yet ("Billing starts May 30, 2024")',
    )
  })

  test('gemini-api docs, June 2025: ids from the AI Studio links, one paid price filed as standard', () => {
    const { out } = parse(
      'google-docs-pricing-2025',
      '20250607103454',
      'google-docs-pricing-2025-06.html',
    )
    expect(out.rows.every((r) => r.tier === 'standard')).toBe(true)
    // "Try it in Google AI Studio" -> aistudio.google.com?model=gemini-2.5-pro-preview-06-05
    expect(prices(find(out.rows, 'gemini-2.5-pro-preview-06-05', 'standard'))).toEqual([
      1.25, 0.31, 10,
    ])
    expect(prices(find(out.rows, 'gemini-2.0-flash', 'standard'))).toEqual([0.1, 0.025, 0.4])
    // "Non-thinking: $0.60 Thinking: $3.50" is no single output price: kept in notes.
    expect(find(out.rows, 'gemini-2.5-flash-preview-05-20', 'standard').output_per_mtok).toBeNull()
    expect(out.passed).toContain('gemini-2.5-flash-preview-tts (no model id on the page)')
  })

  test('gemini-api docs, September 2025: Standard and Batch tiers, still no <code> ids', () => {
    const { out } = parse(
      'google-docs-pricing-2025',
      '20250918150943',
      'google-docs-pricing-2025-09.html',
    )
    expect(out.rows).toHaveLength(15)
    expect(prices(find(out.rows, 'gemini-2.5-pro', 'standard'))).toEqual([1.25, 0.31, 10])
    expect(prices(find(out.rows, 'gemini-2.5-pro', 'batch'))).toEqual([0.625, 0.31, 5])
    // A section with no tier headings on a tiered page stays untiered, as live.
    expect(prices(find(out.rows, 'gemini-1.5-flash', null))).toEqual([0.075, 0.01875, 0.3])
  })
})

describe('xAI', () => {
  test('x.ai/api, March 2025: model cards, one price per model filed as standard', () => {
    const { out } = parse('xai-api-2025', '20250320104541', 'xai-api-2025-03.html')
    expect(out.rows.map((r) => [r.model_slug, r.tier, ...prices(r)])).toEqual([
      ['grok-2-1212', 'standard', 2, null, 10],
      ['grok-2-vision-1212', 'standard', 2, null, 10],
    ])
    expect(find(out.rows, 'grok-2-vision-1212', 'standard').notes).toContain('image input $2.00')
  })

  test('x.ai/api: a page that hides older models is skipped', () => {
    const prov = fixtureProvenance('wayback-xai-api-2025-20250320104541')
    const html =
      '<p>grok-3 Our flagship model. Capabilities Context window 131072 Text Input $3.00 Image Input - Output $15.00</p>' +
      '<button>Show older models</button></html>'
    expect(() => eraById('xai-api-2025')!.parse(html, prov)).toThrow('featured models only')
  })

  test('docs.x.ai/docs/models, December 2025: the Model Pricing table, regions merged', () => {
    const { out } = parse('xai-docs-models-2025', '20251202224031', 'xai-docs-models-2025-12.html')
    expect(out.rows).toHaveLength(9)
    // "grok-4-0709 | … | $3.00 $15.00": input, then output.
    expect(prices(find(out.rows, 'grok-4-0709', 'standard'))).toEqual([3, null, 15])
    expect(prices(find(out.rows, 'grok-code-fast-1', 'standard'))).toEqual([0.2, null, 1.5])
    // "grok-2-vision-1212 us-east-1" and "… eu-west-1" at one price: one row.
    expect(prices(find(out.rows, 'grok-2-vision-1212', 'standard'))).toEqual([2, null, 10])
    expect(out.passed).toEqual(['grok-2-image-1212 (Image generation models)'])
  })

  test('docs.x.ai models.md, March 2026: "$in ($cached) / $out", repeats merged', () => {
    const { out } = parse('xai-models-md-2026', '20260312220938', 'xai-models-2026-03.md')
    expect(out.rows).toHaveLength(11)
    expect(prices(find(out.rows, 'grok-4.20-beta-0309-reasoning', 'standard'))).toEqual([2, 0.2, 6])
    expect(prices(find(out.rows, 'grok-4-1-fast-non-reasoning', 'standard'))).toEqual([
      0.2, 0.05, 0.5,
    ])
    expect(out.passed).toContain('grok-imagine-video (not priced per token)')
  })

  test('docs.x.ai models.md, June 2026: input and output only, the live key for that price', () => {
    const { out } = parse('xai-models-md-2026', '20260616001005', 'xai-models-2026-06.md')
    // The live page's "grok-4.3 (< 200k prompt tokens)" row prints the same $1.25 / $2.50.
    expect(prices(find(out.rows, 'grok-4.3', 'standard'))).toEqual([1.25, null, 2.5])
    expect(out.rows).toHaveLength(5)
  })
})

describe('Mistral', () => {
  test('docs.mistral.ai/platform/pricing, April 2024: the USD columns, the endpoint as the id', () => {
    const { out } = parse(
      'mistral-docs-pricing-2023',
      '20240413034939',
      'mistral-docs-pricing-2024-04.html',
    )
    // "| Mistral Large | mistral-large-latest | 8$ / 1M tokens | 24$ / 1M tokens | 7.3€ … |"
    expect(out.rows.map((r) => [r.model_slug, r.input_per_mtok, r.output_per_mtok])).toEqual([
      ['mistral-embed', 0.1, null],
      ['mistral-large-latest', 8, 24],
      ['mistral-medium-latest', 2.7, 8.1],
      ['mistral-small-latest', 2, 6],
      ['open-mistral-7b', 0.25, 0.25],
      ['open-mixtral-8x7b', 0.7, 0.7],
    ])
  })

  test('docs.mistral.ai/platform/pricing: a page priced in euros only is skipped, never converted', () => {
    const prov = fixtureProvenance('wayback-mistral-docs-pricing-2023-20240413034939')
    const html =
      '<h3>Chat Completions API</h3><table><tr><th>Model</th><th>Input</th><th>Output</th></tr>' +
      '<tr><td>mistral-tiny</td><td>0.14€ / 1M tokens</td><td>0.42€ / 1M tokens</td></tr></table></html>'
    expect(() => eraById('mistral-docs-pricing-2023')!.parse(html, prov)).toThrow(
      'prices printed in euros only',
    )
  })

  test('mistral.ai/technology, June 2024: USD tables read, EUR twins passed over', () => {
    const { out } = parse(
      'mistral-technology-2024',
      '20240615101417',
      'mistral-technology-2024-06.html',
    )
    expect(out.rows).toHaveLength(8)
    expect(prices(find(out.rows, 'mistral-large-2402'))).toEqual([4, null, 12])
    expect(prices(find(out.rows, 'codestral-2405'))).toEqual([1, null, 3])
    // The EUR twin printed Mistral Embed's output as "$0.1"; only the USD table is read.
    expect(prices(find(out.rows, 'mistral-embed'))).toEqual([0.1, null, 0.1])
  })

  test('mistral.ai/technology, February 2025: Model | API Name columns, aliases kept as printed', () => {
    const { out } = parse(
      'mistral-technology-2024',
      '20250203181801',
      'mistral-technology-2025-02.html',
    )
    expect(out.rows).toHaveLength(13)
    expect(find(out.rows, 'mistral-large-latest')).toMatchObject({
      input_per_mtok: 2,
      output_per_mtok: 6,
      notes: 'Mistral Large 24.11',
    })
    expect(find(out.rows, 'mistral-moderation-latest').output_per_mtok).toBeNull()
  })
})

describe('DeepSeek', () => {
  test('platform.deepseek.com, May 2024: a row per model, the USD table only', () => {
    const { out } = parse(
      'deepseek-platform-pricing-2024',
      '20240525232726',
      'deepseek-platform-pricing-2024-05.html',
    )
    expect(out.rows.map((r) => [r.model_slug, r.tier, ...prices(r)])).toEqual([
      ['deepseek-chat', null, 0.14, null, 0.28],
      ['deepseek-coder', null, 0.14, null, 0.28],
    ])
    expect(find(out.rows, 'deepseek-chat').notes).toBe('printed as "deepseek-chat *"')
  })

  test('api-docs, December 2024: the original price stored, the discount in notes', () => {
    const { out } = parse(
      'deepseek-api-docs-pricing-2024',
      '20241226115837',
      'deepseek-pricing-2024-12.html',
    )
    // "$0.27/ 1M tokens (4) $0.14 / 1M tokens", footnote (4): "the original price and the discounted price"
    expect(prices(find(out.rows, 'deepseek-chat'))).toEqual([0.27, 0.07, 1.1])
    expect(find(out.rows, 'deepseek-chat').notes).toContain(
      'input discounted to $0.14 at the capture',
    )
  })

  test('api-docs, March 2025: STANDARD and DISCOUNT PRICE bands, the discount band as off_peak', () => {
    const { out } = parse(
      'deepseek-api-docs-pricing-2024',
      '20250325062124',
      'deepseek-pricing-2025-03.html',
    )
    expect(prices(find(out.rows, 'deepseek-reasoner'))).toEqual([0.55, 0.14, 2.19])
    expect(find(out.rows, 'deepseek-reasoner', 'off_peak')).toMatchObject({
      input_per_mtok: 0.135,
      cached_input_per_mtok: 0.035,
      output_per_mtok: 0.55,
    })
    expect(find(out.rows, 'deepseek-chat', 'off_peak').notes).toContain(
      'printed as "DISCOUNT PRICE" (UTC 16:30-00:30)',
    )
  })

  test('api-docs, December 2025: one price spanning every model column', () => {
    const { out } = parse(
      'deepseek-api-docs-pricing-2024',
      '20251201114852',
      'deepseek-pricing-2025-12.html',
    )
    // deepseek-reasoner printed in two columns (one on another base URL) at one price: one row.
    expect(out.rows.map((r) => [r.model_slug, ...prices(r)])).toEqual([
      ['deepseek-chat', 0.28, 0.028, 0.42],
      ['deepseek-reasoner', 0.28, 0.028, 0.42],
    ])
  })

  test('api-docs, May 2026: "$0.435 (75% off) $1.74" stores the original', () => {
    const { out } = parse(
      'deepseek-api-docs-pricing-2024',
      '20260501050639',
      'deepseek-pricing-2026-05.html',
    )
    expect(prices(find(out.rows, 'deepseek-v4-pro'))).toEqual([1.74, 0.0145, 3.48])
    expect(prices(find(out.rows, 'deepseek-v4-flash'))).toEqual([0.14, 0.0028, 0.28])
  })

  test('api-docs, August 2026: PEAK and OFF-PEAK, the live layout and the live keys', () => {
    const { out } = parse(
      'deepseek-api-docs-pricing-2024',
      '20260816171438',
      'deepseek-pricing-2026-08.html',
    )
    expect(prices(find(out.rows, 'deepseek-v4-pro'))).toEqual([1.32, 0.044, 3.96])
    expect(prices(find(out.rows, 'deepseek-v4-pro', 'off_peak'))).toEqual([0.66, 0.022, 1.98])
  })
})

describe('Alibaba', () => {
  test('Model Studio pricing, January 2026: the International tab of each Qwen line', () => {
    const { out } = parse(
      'alibaba-model-pricing-2026',
      '20260116072901',
      'alibaba-model-pricing-2026-01.html',
    )
    expect(out.rows).toHaveLength(29)
    expect(find(out.rows, 'qwen3-max')).toMatchObject({
      input_per_mtok: 1.2,
      output_per_mtok: 6,
      notes: 'Qwen-Max, International tab; input tokens per request 0<Token≤32K',
    })
    expect(prices(find(out.rows, 'qwen3-max', 'input_32k_128k'))).toEqual([2.4, null, 12])
    expect(find(out.rows, 'qwen-plus').notes).toContain('thinking-mode output $4')
  })

  test('Model Studio pricing, August 2026: the Singapore tab’s International rows, as live', () => {
    const { out } = parse(
      'alibaba-model-pricing-2026',
      '20260811054610',
      'alibaba-model-pricing-2026-08.html',
    )
    expect(out.rows).toHaveLength(57)
    // "List price $2.5 Limited-time 50% off": the list price, the promotion in notes.
    expect(find(out.rows, 'qwen3.7-max').notes).toContain(
      'list price shown; Limited-time 50% off at the read',
    )
    expect(prices(find(out.rows, 'qwen3.7-max'))).toEqual([2.5, null, 7.5])
    // "-" under thinking mode: a snapshot with no thinking mode.
    expect(prices(find(out.rows, 'qwen-plus-2025-01-25'))).toEqual([0.4, null, 1.2])
  })
})
