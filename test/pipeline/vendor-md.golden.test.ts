import { describe, expect, test } from 'vitest'

import {
  EdgarFtsOutput,
  EdgarSubmissionsOutput,
  VendorMdPricingOutput,
  modelKey,
} from '../../server/pipeline/contracts'
import { parseAnthropicModelsOverviewMd } from '../../server/pipeline/parsers/pricing/anthropic-models-overview'
import { parseAnthropicPricingMd } from '../../server/pipeline/parsers/pricing/anthropic-pricing'
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
    expect(out.rows).toHaveLength(134)
    expect(out.rows.every((r) => r.provider === 'openai' && r.context_window === null)).toBe(true)
    const tiers = new Map<string | null, number>()
    for (const r of out.rows) tiers.set(r.tier, (tiers.get(r.tier) ?? 0) + 1)
    expect([...tiers.entries()].sort()).toEqual([
      [null, 37],
      ['batch', 35],
      ['batch_long_context', 7],
      ['fast', 19],
      ['fast_long_context', 4],
      ['flex', 17],
      ['flex_long_context', 7],
      ['long_context', 8],
    ])
    const row = (slug: string, tier: string | null) =>
      out.rows.find((r) => r.model_slug === slug && r.tier === tier)!
    // "| gpt-5.6-sol | $4.00 | $0.40 | $5.00 | $20.00 | $8.00 | $0.80 | $10.00 | $30.00 |"
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
    expect(row('gpt-5.6-sol', 'fast').output_per_mtok).toBe(40)
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

    // 17 models in "Model pricing" (tier null) + the same 17 in "Batch
    // processing" (tier "batch").
    expect(priced.rows.length).toBe(34)
    expect(priced.rows.filter((r) => r.tier === null).length).toBe(17)
    expect(priced.rows.filter((r) => r.tier === 'batch').length).toBe(17)

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
    expect(base('claude-haiku-3-5').notes).toContain('retired, except on Bedrock and Google Cloud')
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
      'claude-haiku-4-5',
      'claude-opus-5',
      'claude-sonnet-5',
    ])
    const cat = (slug: string) => catalog.rows.find((r) => r.model_slug === slug)!
    expect(cat('claude-fable-5-1').context_window).toBe('1M tokens')
    expect(cat('claude-haiku-4-5').context_window).toBe('200K tokens')
    expect(cat('claude-haiku-4-5').input_per_mtok).toBe(1)
    expect(cat('claude-haiku-4-5').output_per_mtok).toBe(5)
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

  test('cik whitelist: current sources.yaml parses to exactly the 5 entries, every CIK resolved from SEC', () => {
    // AMZN and NVDA were null until 2026-08-25, when they were resolved from
    // SEC's ticker map and verified against data.sec.gov — never filled in
    // from memory.
    expect([...whitelist.entries()]).toEqual([
      ['MSFT', '0000789019'],
      ['AMZN', '0001018724'],
      ['NVDA', '0001045810'],
      ['SPCX', '0001181412'],
      ['GOOGL', '0001652044'],
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
