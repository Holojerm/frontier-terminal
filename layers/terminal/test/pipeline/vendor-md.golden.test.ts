import { describe, expect, test } from 'vitest'

import {
  EdgarFtsOutput,
  EdgarSubmissionsOutput,
  VendorMdPricingOutput,
  modelKey,
} from '../../server/pipeline/contracts'
import { parseAnthropicModelsOverviewMd } from '../../server/pipeline/parsers/pricing/anthropic-models-overview'
import { parseAnthropicPricingMd } from '../../server/pipeline/parsers/pricing/anthropic-pricing'
import { parseMetaModelsMd } from '../../server/pipeline/parsers/pricing/meta-models'
import { parseMetaPricingMd } from '../../server/pipeline/parsers/pricing/meta-pricing'
import { parseMistralModelsMd } from '../../server/pipeline/parsers/pricing/mistral-models'
import { parseMistralPricingMd } from '../../server/pipeline/parsers/pricing/mistral-pricing'
import { parseOpenAiModelsMd } from '../../server/pipeline/parsers/pricing/openai-models'
import { parseOpenAiPricingMd } from '../../server/pipeline/parsers/pricing/openai-pricing'
import { parseXaiModelsMd } from '../../server/pipeline/parsers/pricing/xai-models'
import { parseEdgarFts } from '../../server/pipeline/parsers/sec/edgar-fts'
import { parseEdgarSubmissionsSpcx } from '../../server/pipeline/parsers/sec/edgar-submissions'
import { isTrackedForm } from '../../server/pipeline/parsers/sec/forms'
import { isS1FloorForm, s1FloorFilings } from '../../server/pipeline/parsers/sec/s1-floor'
import {
  parseCikWhitelistBlock,
  whitelistCikFor,
} from '../../server/pipeline/parsers/sec/whitelist'
import { fixtureText, provenanceOf } from './fixtures'
import catalog1008 from '~/fixtures/pricing/anthropic-models-overview.2026-10-08.md?raw'
import pricing1008 from '~/fixtures/pricing/anthropic-pricing.2026-10-08.md?raw'

// Vendor .md pricing/catalog + EDGAR golden tests. Fixtures:
// fixtures/pricing/*.md, fixtures/sec/* (provenance in fixtures/manifest.json).
// Registration in parsers.manifest.ts puts every parser here through the
// determinism gate as well.

const SPCX_CIK = '0001181412'
const whitelist = parseCikWhitelistBlock(fixtureText('sources.yaml'))

describe('vendor-md + sec lane', () => {
  test('openai: pricing.md yields one row per model, service tier and context band, promo bounds kept as notes', () => {
    const out = parseOpenAiPricingMd(fixtureText('fixtures/pricing/openai-pricing.md'))
    expect(VendorMdPricingOutput.safeParse(out).success).toBe(true)
    expect(out.rows).toHaveLength(163)
    expect(out.rows.every((r) => r.provider === 'openai' && r.context_window === null)).toBe(true)
    const tiers = new Map<string | null, number>()
    for (const r of out.rows) tiers.set(r.tier, (tiers.get(r.tier) ?? 0) + 1)
    expect([...tiers.entries()].sort()).toEqual([
      [null, 37],
      ['batch', 36],
      ['batch_long_context', 11],
      ['fast', 23],
      ['fast_long_context', 8],
      ['flex', 21],
      ['flex_long_context', 11],
      ['long_context', 12],
      ['ultrafast', 2],
      ['ultrafast_long_context', 2],
    ])
    const row = (slug: string, tier: string | null) =>
      out.rows.find((r) => r.model_slug === slug && r.tier === tier)!
    // "| gpt-5.6-sol | $4.00 | $20.00 | $0.40 | $5.00 | $10.00 | $8.00 | $30.00 | $0.80 | ..."
    expect(row('gpt-5.6-sol', null)).toMatchObject({
      input_per_mtok: 4,
      cached_input_per_mtok: 0.4,
      output_per_mtok: 20,
      notes: null,
    })
    expect(row('gpt-5.6-sol', 'long_context')).toMatchObject({
      input_per_mtok: 8,
      output_per_mtok: 30,
      notes: 'long context',
    })
    expect(row('gpt-5.6-sol', 'batch').input_per_mtok).toBe(2)
    expect(row('gpt-5.6-sol', 'flex').output_per_mtok).toBe(10)
    expect(row('gpt-5.6-sol', 'fast').output_per_mtok).toBe(40)
    expect(row('gpt-6.1-sol', 'ultrafast')).toMatchObject({
      input_per_mtok: 12,
      output_per_mtok: 60,
    })
    // A legacy table prints one band: its rows are the tier's short-context row.
    // "| gpt-4o-mini | $0.15 | $0.60 | $0.075 |"
    expect(row('gpt-4o-mini', null)).toMatchObject({
      input_per_mtok: 0.15,
      cached_input_per_mtok: 0.075,
      output_per_mtok: 0.6,
    })
    expect(row('gpt-4o-mini', 'batch').cached_input_per_mtok).toBeNull()
    // "| gpt-5.5 (<272K context length) | $5.00 | ..." — the bound is a note, not a window.
    expect(row('gpt-5.5', null)).toMatchObject({
      input_per_mtok: 5,
      notes: 'short context: <272K context length',
    })
    expect(row('gpt-5.5', 'long_context').notes).toBe('long context: beyond <272K context length')
    // A "-" cell is null, never zero; a model with no long-context prices has no long row.
    expect(row('gpt-5.5-pro', null).cached_input_per_mtok).toBeNull()
    expect(
      out.rows.find((r) => r.model_slug === 'gpt-4o-mini' && r.tier === 'long_context'),
    ).toBeUndefined()
    // Cyber, audio and image tables are not parsed.
    expect(out.rows.some((r) => r.model_slug === 'gpt-5.6-cyber')).toBe(false)
    for (const r of out.rows)
      expect(r.source_url).toBe('https://developers.openai.com/api/docs/pricing.md')
  })

  test('openai: parses fixtures/pricing/openai-models.md into PriceRow[] with model slugs as stable keys', () => {
    const out = parseOpenAiModelsMd(fixtureText('fixtures/pricing/openai-models.md'))
    expect(VendorMdPricingOutput.safeParse(out).success).toBe(true)

    // Full catalog: 100 entries, slugs unique (they ARE the stable keys).
    expect(out.rows.length).toBe(100)
    expect(new Set(out.rows.map((r) => r.model_slug)).size).toBe(100)
    expect(out.rows.every((r) => r.provider === 'openai')).toBe(true)

    const astra = out.rows.find((r) => r.model_slug === 'gpt-6-astra')
    expect(astra).toBeDefined()
    expect(astra!.notes).toBe('Our most capable model, built for the hardest end-to-end work')
    const sol = out.rows.find((r) => r.model_slug === 'gpt-5.6-sol')
    expect(sol).toBeDefined()
    expect(sol!.notes).toBe('Flagship model for complex professional work')

    // Price honesty: this page prints no prices and no context windows —
    // every nullable field stays null on every row, never guessed.
    for (const row of out.rows) {
      expect(row.input_per_mtok).toBeNull()
      expect(row.cached_input_per_mtok).toBeNull()
      expect(row.output_per_mtok).toBeNull()
      expect(row.context_window).toBeNull()
      // Provenance from fixtures/manifest.json, on every row.
      expect(row.source_url).toBe('https://developers.openai.com/api/docs/models.md')
      expect(row.fetched_at).toBe(provenanceOf('openai-models-md').fetched_at)
    }
  })

  test('anthropic: parses fixtures/pricing/anthropic-pricing.md price tables (models overview for catalog fields)', () => {
    const priced = parseAnthropicPricingMd(fixtureText('fixtures/pricing/anthropic-pricing.md'))
    expect(VendorMdPricingOutput.safeParse(priced).success).toBe(true)

    // 20 models in "Model pricing" (tier null) + the same 20 in "Batch
    // processing" (tier "batch"), and Haiku 5.5's long-prompt band in each.
    expect(priced.rows.length).toBe(42)
    expect(priced.rows.filter((r) => r.tier === null).length).toBe(20)
    expect(priced.rows.filter((r) => r.tier === 'batch').length).toBe(20)
    expect(priced.rows.filter((r) => r.tier === 'long_context').length).toBe(1)
    expect(priced.rows.filter((r) => r.tier === 'batch_long_context').length).toBe(1)

    const base = (slug: string) =>
      priced.rows.find((r) => r.model_slug === slug && r.tier === null)!
    // Exact printed numbers; cached input = "Cache Hits & Refreshes" column.
    expect(base('claude-opus-4-5').input_per_mtok).toBe(5)
    expect(base('claude-opus-4-5').cached_input_per_mtok).toBe(0.5)
    expect(base('claude-opus-4-5').output_per_mtok).toBe(25)
    expect(base('claude-sonnet-5').input_per_mtok).toBe(2)
    expect(base('claude-sonnet-5').output_per_mtok).toBe(10)
    expect(base('claude-haiku-3-5').input_per_mtok).toBe(0.8)
    expect(base('claude-haiku-3-5').cached_input_per_mtok).toBe(0.08)
    expect(base('claude-haiku-3-5').output_per_mtok).toBe(4)
    // Printed caveat travels with the row; cache-write prices ride verbatim.
    expect(base('claude-haiku-3-5').notes).toContain('retired, except on Google Cloud')
    expect(base('claude-fable-5').notes).toBe(
      '5m cache writes $12.50 / MTok; 1h cache writes $20 / MTok',
    )

    const batchHaiku = priced.rows.find(
      (r) => r.model_slug === 'claude-haiku-4-5' && r.tier === 'batch',
    )!
    expect(batchHaiku.input_per_mtok).toBe(0.5)
    expect(batchHaiku.output_per_mtok).toBe(2.5)
    expect(batchHaiku.cached_input_per_mtok).toBeNull() // batch table prints none

    for (const row of priced.rows) {
      expect(row.source_url).toBe('https://platform.claude.com/docs/en/about-claude/pricing.md')
      expect(row.fetched_at).toBe(provenanceOf('anthropic-pricing-md').fetched_at)
    }

    // Catalog fields from the models overview (own parser, source id
    // anthropic-models-md): context windows + the vendor's printed API alias
    // as slug, so both sources join on modelKey.
    const catalog = parseAnthropicModelsOverviewMd(
      fixtureText('fixtures/pricing/anthropic-models-overview.md'),
    )
    expect(VendorMdPricingOutput.safeParse(catalog).success).toBe(true)
    expect(catalog.rows.map((r) => r.model_slug)).toEqual([
      'claude-fable-5-1',
      'claude-haiku-5-5',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
    ])
    const cat = (slug: string) => catalog.rows.find((r) => r.model_slug === slug)!
    expect(cat('claude-fable-5-1').context_window).toBe('1M tokens')
    expect(cat('claude-opus-5-5').input_per_mtok).toBe(4)
    expect(cat('claude-opus-5-5').output_per_mtok).toBe(20)
    expect(cat('claude-fable-5-1').source_url).toBe(
      'https://platform.claude.com/docs/en/models/overview.md',
    )

    // Cross-source consistency: the overview's printed base prices agree
    // with the pricing page for all four current models.
    for (const row of catalog.rows) {
      expect(base(row.model_slug).input_per_mtok).toBe(row.input_per_mtok!)
      expect(base(row.model_slug).output_per_mtok).toBe(row.output_per_mtok!)
    }
  })

  // Live captures of 2026-10-08, kept beside the manifest fixtures: Claude Haiku
  // 5.5 is priced by prompt length, so the catalog prints "From $0.10 / input
  // MTok, From $0.50 / output MTok" and the pricing page prints two bands.
  describe('anthropic: a model priced by prompt length (captures of 2026-10-08)', () => {
    const prov = {
      source_url: 'https://platform.claude.com/docs/en/models/overview.md',
      fetched_at: '2026-10-08T23:43:06Z',
    }
    const catalog = parseAnthropicModelsOverviewMd(catalog1008, prov)
    const priced = parseAnthropicPricingMd(pricing1008, {
      source_url: 'https://platform.claude.com/docs/en/about-claude/pricing.md',
      fetched_at: '2026-10-08T23:43:06Z',
    })
    const cat = (slug: string) => catalog.rows.find((r) => r.model_slug === slug)!
    const price = (slug: string, tier: string | null) =>
      priced.rows.find((r) => r.model_slug === slug && r.tier === tier)!

    test('a "From" price is stored as the printed figures and flagged in the note', () => {
      expect(VendorMdPricingOutput.safeParse(catalog).success).toBe(true)
      expect(catalog.rows.map((r) => r.model_slug)).toEqual([
        'claude-fable-5-1',
        'claude-haiku-5-5',
        'claude-opus-5-5',
        'claude-sonnet-5-5',
      ])
      expect(cat('claude-haiku-5-5')).toMatchObject({
        tier: null,
        input_per_mtok: 0.1,
        output_per_mtok: 0.5,
        context_window: '1M tokens',
      })
      expect(cat('claude-haiku-5-5').notes).toBe(
        'For high-volume, latency-sensitive tasks such as classification, extraction, and routing. Printed as a "From" price: the lowest band, higher for longer prompts',
      )
      // A plainly priced model carries no such flag.
      expect(cat('claude-opus-5-5')).toMatchObject({ input_per_mtok: 4, output_per_mtok: 20 })
      expect(cat('claude-opus-5-5').notes).toBe(
        'For long-running agentic coding and knowledge work',
      )
    })

    test('the "From" figures are the pricing page’s short-prompt row, which joins on the same key', () => {
      const short = price('claude-haiku-5-5', null)
      expect(short.input_per_mtok).toBe(cat('claude-haiku-5-5').input_per_mtok)
      expect(short.output_per_mtok).toBe(cat('claude-haiku-5-5').output_per_mtok)
      expect(short.cached_input_per_mtok).toBe(0.01)
      expect(short.notes).toBe(
        'short context: prompts up to 100,000 tokens; 5m cache writes $0.125 / MTok; 1h cache writes $0.20 / MTok',
      )
      for (const row of catalog.rows) {
        expect(price(row.model_slug, null).input_per_mtok).toBe(row.input_per_mtok)
        expect(price(row.model_slug, null).output_per_mtok).toBe(row.output_per_mtok)
      }
    })

    test('the long-prompt band is its own tier, never folded into the slug', () => {
      expect(priced.rows.some((r) => r.model_slug.includes('('))).toBe(false)
      expect(price('claude-haiku-5-5', 'long_context')).toMatchObject({
        input_per_mtok: 0.5,
        output_per_mtok: 2.5,
        cached_input_per_mtok: 0.05,
        notes:
          'long context: prompts over 100,000 tokens; 5m cache writes $0.625 / MTok; 1h cache writes $1 / MTok',
      })
      expect(price('claude-haiku-5-5', 'batch')).toMatchObject({
        input_per_mtok: 0.05,
        output_per_mtok: 0.25,
      })
      expect(price('claude-haiku-5-5', 'batch_long_context')).toMatchObject({
        input_per_mtok: 0.25,
        output_per_mtok: 1.25,
      })
    })

    test('a pricing cell that is not exactly the plain or the "From" form still fails the source', () => {
      const withCell = (cell: string) =>
        catalog1008.replace('From $0.10 / input MTok, From $0.50 / output MTok', cell)
      expect(() =>
        parseAnthropicModelsOverviewMd(withCell('$0.10 / input MTok, $0.50 / output MTok'), prov),
      ).not.toThrow()
      for (const bad of [
        'From $0.10 / input MTok, $0.50 / output MTok', // "From" on one side only
        '$0.10 / input MTok, From $0.50 / output MTok',
        'From $0.10 / input MTok',
        'Contact sales',
        'From $0.10 / MTok',
        'Starting at $0.10 / input MTok, Starting at $0.50 / output MTok',
        'from $0.10 / input MTok, from $0.50 / output MTok',
      ]) {
        expect(() => parseAnthropicModelsOverviewMd(withCell(bad), prov), bad).toThrow(
          'unrecognized pricing cell for claude-haiku-5-5',
        )
      }
    })
  })

  test("xai: long-context dual rows map to tier 'standard' / 'long_context' under the same model_slug", () => {
    const out = parseXaiModelsMd(fixtureText('fixtures/pricing/xai-models.md'))
    expect(VendorMdPricingOutput.safeParse(out).success).toBe(true)

    // 8 text models x 2 tiers — dual rows are never collapsed or averaged.
    expect(out.rows.length).toBe(16)
    const slugs = new Set(out.rows.map((r) => r.model_slug))
    expect(slugs.size).toBe(8)
    for (const slug of slugs) {
      const tiers = out.rows
        .filter((r) => r.model_slug === slug)
        .map((r) => r.tier)
        .sort()
      expect(tiers).toEqual(['long_context', 'standard'])
    }

    const row = (slug: string, tier: string) =>
      out.rows.find((r) => r.model_slug === slug && r.tier === tier)!
    expect(row('grok-4.7', 'standard').input_per_mtok).toBe(2)
    expect(row('grok-4.7', 'standard').output_per_mtok).toBe(6)
    expect(row('grok-4.7', 'long_context').input_per_mtok).toBe(4)
    expect(row('grok-4.6', 'standard').input_per_mtok).toBe(2)
    expect(row('grok-4.6', 'standard').cached_input_per_mtok).toBe(0.5)
    expect(row('grok-4.6', 'standard').output_per_mtok).toBe(6)
    expect(row('grok-4.6', 'long_context').input_per_mtok).toBe(4)
    expect(row('grok-4.6', 'long_context').cached_input_per_mtok).toBe(1)
    expect(row('grok-4.6', 'long_context').output_per_mtok).toBe(12)
    expect(row('grok-4.6', 'standard').context_window).toBe('500k')
    expect(row('grok-build-0.1', 'standard').context_window).toBe('256k')
    expect(row('grok-4.3', 'long_context').input_per_mtok).toBe(2.5)

    // modelKey disambiguates the pair.
    expect(modelKey('xai', 'grok-4.6', 'standard')).not.toBe(
      modelKey('xai', 'grok-4.6', 'long_context'),
    )

    for (const r of out.rows) {
      expect(r.source_url).toBe('https://docs.x.ai/developers/models.md')
      expect(r.fetched_at).toBe(provenanceOf('xai-models-md').fetched_at)
    }
  })

  test('meta: pricing.md fans each line’s price out to every id it names, Contributor ids at the Contributor column', () => {
    const out = parseMetaPricingMd(fixtureText('fixtures/pricing/meta-pricing.md'))
    expect(VendorMdPricingOutput.safeParse(out).success).toBe(true)
    const by = Object.fromEntries(out.rows.map((r) => [r.model_slug, r]))
    expect(out.rows.map((r) => modelKey(r.provider, r.model_slug, r.tier))).toEqual([
      modelKey('meta', 'muse-ember-1.0', null),
      modelKey('meta', 'muse-ember-1.0', 'long_context'),
      modelKey('meta', 'muse-spark-1.1', null),
      modelKey('meta', 'muse-spark-1.2', null),
      modelKey('meta', 'muse-spark-1.2-contributor', null),
      modelKey('meta', 'muse-spark-1.3', null),
      modelKey('meta', 'muse-spark-1.3-contributor', null),
      modelKey('meta', 'muse-wonder-1.0', null),
    ])
    expect(out.rows.every((r) => r.provider === 'meta')).toBe(true)
    expect(out.rows.filter((r) => r.tier !== null).map((r) => r.model_slug)).toEqual([
      'muse-ember-1.0',
    ])
    // "| Cached input | $0.004 | $0.012 |", "| Input | $0.10 | $0.30 |", "| Output | $0.50 | $1.50 |"
    const ember = out.rows.filter((r) => r.model_slug === 'muse-ember-1.0')
    expect(ember.find((r) => r.tier === null)).toMatchObject({
      input_per_mtok: 0.1,
      cached_input_per_mtok: 0.004,
      output_per_mtok: 0.5,
      notes: 'Standard mode; up to 200K input tokens',
    })
    expect(ember.find((r) => r.tier === 'long_context')).toMatchObject({
      input_per_mtok: 0.3,
      cached_input_per_mtok: 0.012,
      output_per_mtok: 1.5,
      notes: 'Standard mode; long context: over 200K input tokens, billed on the whole request',
    })
    expect(by['muse-wonder-1.0']).toMatchObject({
      input_per_mtok: 4,
      cached_input_per_mtok: 0.2,
      output_per_mtok: 20,
    })
    for (const slug of ['muse-spark-1.1', 'muse-spark-1.2', 'muse-spark-1.3']) {
      expect(by[slug]).toMatchObject({
        input_per_mtok: 1.25,
        cached_input_per_mtok: 0.15,
        output_per_mtok: 4.25,
        notes: 'Standard mode',
      })
    }
    expect(by['muse-spark-1.3-contributor']).toMatchObject({
      input_per_mtok: 0.1,
      cached_input_per_mtok: 0.002,
      output_per_mtok: 0.2,
    })
    expect(by['muse-spark-1.3-contributor']!.notes).toContain('train future Meta models')
    for (const r of out.rows) {
      expect(r.source_url).toBe('https://dev.meta.ai/docs/pricing-rate-limits.md')
      expect(r.fetched_at).toBe(provenanceOf('meta-pricing-md').fetched_at)
    }
  })

  test('meta: a line priced for an id in a mode the table marks "Not available" fails, not a null price', () => {
    const text = fixtureText('fixtures/pricing/meta-pricing.md').replace(
      'Model: `muse-wonder-1.0`.',
      'Models: `muse-wonder-1.0` in Standard mode; `muse-wonder-1.0-contributor` in Contributor mode.',
    )
    expect(() => parseMetaPricingMd(text)).toThrow('priced "Not available"')
  })

  test('meta: a reshaped token table fails loudly rather than dropping the line', () => {
    const text = fixtureText('fixtures/pricing/meta-pricing.md').replace(
      '| Usage        | Contributor mode (per 1M tokens) | Standard mode (per 1M tokens) |\n|',
      '| Usage        | Contributor mode (per 1M tokens) | Price (per 1M tokens) |\n|',
    )
    expect(() => parseMetaPricingMd(text)).toThrow('unrecognized header')
  })

  test('meta: a line priced by request size reads its up-to/over columns by name, in either order', () => {
    const current = fixtureText('fixtures/pricing/meta-pricing.md')
    const lines = current.split('\n')
    const ember = lines.indexOf('### Muse Ember')
    expect(ember).toBeGreaterThan(-1)
    const swapped = lines
      .map((line, i) => {
        const cells = line.split('|')
        // Only Muse Ember's table: the first five-cell rows after its heading.
        if (i < ember || i > ember + 12 || cells.length !== 5) return line
        return [cells[0], cells[1], cells[3], cells[2], cells[4]].join('|')
      })
      .join('\n')
    expect(swapped).toContain(
      '| Over 200K input tokens (per 1M tokens) | Up to 200K input tokens (per 1M tokens) |',
    )
    expect(parseMetaPricingMd(swapped)).toEqual(parseMetaPricingMd(current))
  })

  test('meta: a size-priced line naming a Contributor id fails, since the table has no Contributor column', () => {
    const text = fixtureText('fixtures/pricing/meta-pricing.md').replace(
      'Model: `muse-ember-1.0`, in Standard mode only.',
      'Models: `muse-ember-1.0` in Standard mode; `muse-ember-1.0-contributor` in Contributor mode.',
    )
    expect(() => parseMetaPricingMd(text)).toThrow('no column for')
  })

  test('meta: up-to and over columns with different thresholds are not a size-priced table', () => {
    const text = fixtureText('fixtures/pricing/meta-pricing.md').replace(
      'Over 200K input tokens (per 1M tokens)',
      'Over 128K input tokens (per 1M tokens)',
    )
    expect(() => parseMetaPricingMd(text)).toThrow('unrecognized header')
  })

  test('meta: the mode columns are read by name, so either column order gives the same rows', () => {
    // Before 2026-11-09 the page printed Standard first; the capture prints Contributor first.
    const current = fixtureText('fixtures/pricing/meta-pricing.md')
    const swapped = current
      .split('\n')
      .map((line) => {
        const cells = line.split('|')
        if (cells.length !== 5 || !/^\s*(Usage|:-+|Cached input|Input|Output)\s*$/.test(cells[1]!))
          return line
        return [cells[0], cells[1], cells[3], cells[2], cells[4]].join('|')
      })
      .join('\n')
    expect(swapped).toContain(
      '| Standard mode (per 1M tokens) | Contributor mode (per 1M tokens) |',
    )
    expect(parseMetaPricingMd(swapped)).toEqual(parseMetaPricingMd(current))
  })

  const metaSide = (id: string) =>
    fixtureText(
      {
        'meta-muse-wonder-md': 'fixtures/pricing/meta-muse-wonder.md',
        'meta-muse-spark-md': 'fixtures/pricing/meta-muse-spark.md',
        'meta-muse-ember-md': 'fixtures/pricing/meta-muse-ember.md',
      }[id]!,
    )

  test('meta: models.md joined with each line’s page lists the Model API ids with their context window and no prices', () => {
    const out = parseMetaModelsMd(fixtureText('fixtures/pricing/meta-models.md'), metaSide)
    expect(VendorMdPricingOutput.safeParse(out).success).toBe(true)
    // Muse Wonder Full (Muse Code only), the per-image/per-hour lines and the
    // open-weight lines are not API text SKUs.
    expect(out.rows.map((r) => r.model_slug)).toEqual([
      'muse-ember-1.0',
      'muse-spark-1.1',
      'muse-spark-1.2',
      'muse-spark-1.2-contributor',
      'muse-spark-1.3',
      'muse-spark-1.3-contributor',
      'muse-wonder-1.0',
    ])
    for (const r of out.rows) {
      expect(r).toMatchObject({
        provider: 'meta',
        tier: null,
        context_window: '1,048,576 tokens',
        input_per_mtok: null,
        output_per_mtok: null,
      })
    }
    const wonder = out.rows.find((r) => r.model_slug === 'muse-wonder-1.0')!
    expect(wonder.notes).toBe('Muse Wonder; Model API: Available (Standard mode only); preview')
    expect(out.rows.find((r) => r.model_slug === 'muse-spark-1.3-contributor')!.notes).toBe(
      'Muse Spark 1.3 Contributor; Model API: Contributor mode',
    )
    // Muse Ember's models.md table prints no Context window; its page's At a glance does.
    expect(out.rows.find((r) => r.model_slug === 'muse-ember-1.0')!.notes).toBe(
      'Muse Ember; Model API: Standard mode',
    )
    // The catalog and the price list key the same ids, so the two pages join on
    // modelKey. The price list's one extra key is Muse Ember's long_context row,
    // a tier of the same id.
    const priced = parseMetaPricingMd(fixtureText('fixtures/pricing/meta-pricing.md')).rows
    expect(out.rows.map((r) => modelKey(r.provider, r.model_slug, r.tier))).toEqual(
      priced.filter((r) => r.tier === null).map((r) => modelKey(r.provider, r.model_slug, r.tier)),
    )
  })

  test('meta: a text line printing no Context window column still fails without a registered page', () => {
    const models = fixtureText('fixtures/pricing/meta-models.md').replace(
      '## Muse Image',
      '## Muse Nova\n\n| Model ID | Input | Output |\n| :--- | :--- | :--- |\n| `muse-nova-1.0` | Text | Text |\n\n## Muse Image',
    )
    expect(() => parseMetaModelsMd(models, metaSide)).toThrow(
      'Muse Nova: a text line with no page in META_LINE_PAGES',
    )
  })

  test('meta: a new text line without a registered page, or an id its page omits, fails the parse', () => {
    const models = fixtureText('fixtures/pricing/meta-models.md')
    const newLine = models.replace(
      '## Muse Image',
      '## Muse Nova\n\n| Model ID | Input | Output | Context window |\n| :-- | :-- | :-- | :-- |\n| `muse-nova-1.0` | Text | Text | 262,144 tokens |\n\n## Muse Image',
    )
    expect(() => parseMetaModelsMd(newLine, metaSide)).toThrow('Muse Nova')
    const sparkWithout13 = (id: string) =>
      id === 'meta-muse-spark-md'
        ? metaSide(id)
            .split('\n')
            .filter((l) => !l.includes('`muse-spark-1.3`'))
            .join('\n')
        : metaSide(id)
    expect(() => parseMetaModelsMd(models, sparkWithout13)).toThrow('muse-spark-1.3')
  })

  test('mistral: pricing.md keeps the per-MTok lines of Mistral’s own models, never a resold one', () => {
    const out = parseMistralPricingMd(fixtureText('fixtures/pricing/mistral-pricing.md'))
    expect(VendorMdPricingOutput.safeParse(out).success).toBe(true)
    const by = Object.fromEntries(out.rows.map((r) => [r.model_slug, r]))
    // OCR (per page), Voxtral transcribe (per minute), TTS (per character),
    // the free moderation model and the three Z.ai / DeepSeek rows are absent.
    expect(Object.keys(by)).toEqual([
      'codestral-2508',
      'codestral-embed-2505',
      'ministral-14b-2512',
      'ministral-3b-2512',
      'ministral-8b-2512',
      'mistral-embed-2312',
      'mistral-large-4',
      'mistral-small-2603',
      'voxtral-small-2507',
    ])
    expect(out.rows.every((r) => r.provider === 'mistral' && r.tier === null)).toBe(true)
    expect(by['mistral-large-4']).toMatchObject({
      input_per_mtok: 0.7,
      cached_input_per_mtok: 0.07,
      output_per_mtok: 2.1,
      notes: 'Mistral Large 4; Generalist models',
    })
    expect(by['mistral-small-2603']).toMatchObject({
      input_per_mtok: 0.15,
      cached_input_per_mtok: null,
      output_per_mtok: 0.6,
    })
    // Voxtral Small's per-minute audio line is dropped; its token lines stay.
    expect(by['voxtral-small-2507']).toMatchObject({ input_per_mtok: 0.1, output_per_mtok: 0.4 })
    // An embedding model prints an input price only.
    expect(by['mistral-embed-2312']).toMatchObject({ input_per_mtok: 0.1, output_per_mtok: null })
    for (const r of out.rows) {
      expect(r.source_url).toBe('https://docs.mistral.ai/inference/pricing.md')
      expect(r.fetched_at).toBe(provenanceOf('mistral-pricing-md').fetched_at)
    }
  })

  test('mistral: a price line in a unit the parser does not know fails, not a dropped price', () => {
    const text = fixtureText('fixtures/pricing/mistral-pricing.md').replace(
      'Output $2.1 /M Tokens',
      'Output $2.1 /K Tokens',
    )
    expect(() => parseMistralPricingMd(text)).toThrow('unrecognized price line')
  })

  test('mistral: models.md lists current first-party ids with their context, no prices', () => {
    const out = parseMistralModelsMd(fixtureText('fixtures/pricing/mistral-models.md'))
    expect(VendorMdPricingOutput.safeParse(out).success).toBe(true)
    const slugs = out.rows.map((r) => r.model_slug)
    expect(slugs).toHaveLength(16)
    // Third-party resold models, no-API rows and the deprecated table are not catalog rows.
    for (const absent of ['zai-glm-5-3', 'deepseek-v4-1-flash-1017', 'mistral-medium-3-5']) {
      expect(slugs).not.toContain(absent)
    }
    expect(out.rows.find((r) => r.model_slug === 'mistral-large-4')).toMatchObject({
      provider: 'mistral',
      context_window: '1M',
      input_per_mtok: null,
      output_per_mtok: null,
      notes: 'Mistral Large 4; Public Preview',
    })
    // "--" is the page's blank, not a context window.
    expect(
      out.rows.find((r) => r.model_slug === 'voxtral-mini-transcribe-realtime-3-0')!.context_window,
    ).toBeNull()
    // Every priced id is in the catalog, so the two pages join on modelKey.
    const priced = parseMistralPricingMd(fixtureText('fixtures/pricing/mistral-pricing.md')).rows
    const keys = new Set(out.rows.map((r) => modelKey(r.provider, r.model_slug, r.tier)))
    for (const r of priced) expect(keys).toContain(modelKey(r.provider, r.model_slug, r.tier))
  })

  test('mistral: a third-party row from a maker the parsers do not know fails the catalog parse', () => {
    const text = fixtureText('fixtures/pricing/mistral-models.md').replace(
      '| [Z.ai GLM 5.3](/models/zai-glm-5-3) | `zai-glm-5-3` |',
      '| [Qwen 4](/models/qwen-4) | `qwen-4` |',
    )
    expect(() => parseMistralModelsMd(text)).toThrow('not in THIRD_PARTY_MAKERS')
  })

  test('edgar: FTS hits filtered against sources.yaml cik_whitelist; whitelist_cik null on non-matches', () => {
    const out = parseEdgarFts(fixtureText('fixtures/sec/edgar-fts.json'), whitelist)
    expect(EdgarFtsOutput.safeParse(out).success).toBe(true)

    // All 50 hits kept — the open query is known-noisy, and non-whitelist
    // hits keep whitelist_cik null rather than being dropped silently.
    expect(out.rows.length).toBe(50)

    const whitelisted = out.rows.filter((r) => r.whitelist_cik !== null)
    expect(whitelisted.length).toBe(3) // the three SPCX S-1 filings
    expect(whitelisted.every((r) => r.whitelist_cik === SPCX_CIK)).toBe(true)
    expect(whitelisted.map((r) => r.accession_no).sort()).toEqual([
      '0001628280-26-036936',
      '0001628280-26-039276',
      '0001628280-26-040364',
    ])
    expect(out.rows.filter((r) => r.whitelist_cik === null).length).toBe(47)

    // Known noise stays present but unmatched: Reddit's S-1 and Cerebras's
    // S-1 are real hits for the "Anthropic" keyword, not whitelist filers.
    const reddit = out.rows.find((r) => r.accession_no === '0001628280-24-006294')!
    expect(reddit.form).toBe('S-1')
    expect(reddit.whitelist_cik).toBeNull()
    const cerebras = out.rows.find((r) => r.accession_no === '0001628280-26-025762')!
    expect(cerebras.ciks).toEqual(['0002021728'])
    expect(cerebras.whitelist_cik).toBeNull()

    for (const r of out.rows) {
      expect(r.source_url).toBe(
        'https://efts.sec.gov/LATEST/search-index?q=%22Anthropic%22&forms=S-1',
      )
      expect(r.fetched_at).toBe('2026-08-25T11:10:55Z')
    }
  })

  test('edgar: S-1/424B4 form on a whitelisted CIK is flagged (feeds the s1-floor alert rule)', () => {
    // Form matcher: S-1 family + final prospectus only. DRS stays out —
    // confidential drafts are invisible until flipped public.
    expect(isS1FloorForm('S-1')).toBe(true)
    expect(isS1FloorForm('S-1/A')).toBe(true)
    expect(isS1FloorForm('424B4')).toBe(true)
    expect(isS1FloorForm('DRS')).toBe(false)
    expect(isS1FloorForm('DRS/A')).toBe(false)
    expect(isS1FloorForm('S-8')).toBe(false)
    expect(isS1FloorForm('8-K')).toBe(false)
    expect(isS1FloorForm('10-Q')).toBe(false)
    expect(isS1FloorForm('D')).toBe(false)

    // Submissions feed (SPCX, a whitelisted CIK): 81 filings in the
    // payload, 13 on a tracked form (forms.ts drops Form 4 / D / 13G and
    // the rest), of which exactly the S-1, two S-1/As, and the 424B4 trip
    // the floor.
    const subs = parseEdgarSubmissionsSpcx(
      fixtureText('fixtures/sec/edgar-submissions-spcx.json'),
      whitelist,
    )
    expect(EdgarSubmissionsOutput.safeParse(subs).success).toBe(true)
    expect(subs.rows.length).toBe(13)
    expect(subs.rows.map((r) => r.form).every(isTrackedForm)).toBe(true)
    expect(subs.rows.every((r) => r.whitelist_cik === SPCX_CIK)).toBe(true)

    const flagged = s1FloorFilings(subs.rows)
    expect(flagged.map((r) => r.form).sort()).toEqual(['424B4', 'S-1', 'S-1/A', 'S-1/A'])
    expect(flagged.map((r) => r.accession_no).sort()).toEqual([
      '0001628280-26-036936', // S-1        2026-05-20
      '0001628280-26-039276', // S-1/A      2026-06-01
      '0001628280-26-040364', // S-1/A      2026-06-03
      '0001628280-26-042639', // 424B4      2026-06-12
    ])

    // FTS feed: only the whitelisted SPCX rows trip the floor; the 47
    // non-whitelist S-1 hits (e.g. Cerebras, Reddit) never do.
    const fts = parseEdgarFts(fixtureText('fixtures/sec/edgar-fts.json'), whitelist)
    const ftsFlagged = s1FloorFilings(fts.rows)
    expect(ftsFlagged.length).toBe(3)
    expect(ftsFlagged.every((r) => r.whitelist_cik === SPCX_CIK)).toBe(true)
  })

  test('cik whitelist: current sources.yaml parses to exactly the 8 entries, every CIK resolved from SEC', () => {
    // AMZN and NVDA were null until 2026-08-25, when they were resolved from
    // SEC's ticker map and verified against data.sec.gov — never filled in
    // from memory. ORCL and BABA were resolved the same way on 2026-11-04.
    expect([...whitelist.entries()]).toEqual([
      ['MSFT', '0000789019'],
      ['AMZN', '0001018724'],
      ['NVDA', '0001045810'],
      ['SPCX', '0001181412'],
      ['GOOGL', '0001652044'],
      ['META', '0001326801'],
      ['ORCL', '0001341439'],
      ['BABA', '0001577552'],
    ])
  })

  test('cik whitelist: a null entry never matches; the first whitelisted CIK in source order wins', () => {
    const partial = new Map<string, string | null>([
      ['AMZN', null],
      ['SPCX', SPCX_CIK],
    ])
    expect(whitelistCikFor(['0001018724'], partial)).toBeNull() // AMZN's real CIK, but the entry is null
    expect(whitelistCikFor(['0000000001', SPCX_CIK], partial)).toBe(SPCX_CIK)
    expect(whitelistCikFor([], partial)).toBeNull()
  })

  test('cik whitelist: an unparseable indented line inside the block throws instead of silently truncating', () => {
    // The pre-hardening failure mode: a formatting drift on the SPCX line
    // would have ended the block early and silently dropped GOOGL,
    // suppressing an s1-floor alert. Now it throws with the offending line.
    const drifted = [
      'cik_whitelist:',
      '  MSFT: "0000789019"',
      '  SPCX: 0001181412', // unquoted — not `  TICKER: "digits" | null`
      '  GOOGL: "0001652044"',
      '',
    ].join('\n')
    expect(() => parseCikWhitelistBlock(drifted)).toThrow(
      'cik_whitelist line 3 is not `  TICKER: "digits" | null`: "  SPCX: 0001181412"',
    )

    // Dedent (the next top-level key) is still a clean stop, not an error.
    const wellFormed = [
      'cik_whitelist:',
      '  SPCX: "0001181412"',
      '  AMZN: null',
      'next_key:',
      '  SPCX: "9999999999"', // past the block — must not be read
    ].join('\n')
    expect([...parseCikWhitelistBlock(wellFormed).entries()]).toEqual([
      ['SPCX', '0001181412'],
      ['AMZN', null],
    ])
  })
})
