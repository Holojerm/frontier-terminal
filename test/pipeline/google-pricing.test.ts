/// <reference types="vite/client" />

// Deterministic Google pricing parser, checked against two snapshots of the
// page: the 2026-08-25 fixture (with hand-verified ground truth from the
// take-home's agent lane, fixtures/pricing/google-pricing.expected.json) and
// the 2026-09-07 page, which adds models and drops others — proof the parser
// reads structure rather than one snapshot's bytes.

import { describe, expect, it } from 'vitest'

import live from '~/fixtures/pricing/google-pricing.2026-09-07.html?raw'
import expected from '~/fixtures/pricing/google-pricing.expected.json'
import fixture from '~/fixtures/pricing/google-pricing.html?raw'
import {
  GooglePricingOutput,
  parseGooglePricing,
  parseGooglePricingPage,
  type GooglePricingRow,
} from '~/server/pipeline/parsers/pricing/google-pricing'

const SOURCE_URL = 'https://ai.google.dev/gemini-api/docs/pricing'
const FIXTURE_PROV = { source_url: SOURCE_URL, fetched_at: '2026-08-25T11:10:42Z' }
const LIVE_PROV = { source_url: SOURCE_URL, fetched_at: '2026-09-07T00:00:00Z' }

const PRICE_FIELDS = ['input_per_mtok', 'cached_input_per_mtok', 'output_per_mtok'] as const

type Keyed = Pick<GooglePricingRow, 'model_slug' | 'tier' | 'effective_from' | 'effective_until'>
const rowKey = (r: Keyed) => `${r.model_slug}|${r.tier}|${r.effective_from}|${r.effective_until}`

// The take-home's grounding tripwires (pipeline/src/agent/grounding.ts):
// a slug must be printed verbatim in a <code> element, and every non-null
// price must literally appear in the page ("$7.50" grounds 7.5).
function codeSlugs(html: string): Set<string> {
  return new Set([...html.matchAll(/<code[^>]*>([^<]+)<\/code>/g)].map((m) => m[1]!.trim()))
}
function numericTokens(html: string): Set<string> {
  const normalized = html.replace(/,(?=\d)/g, '').replace(/\$\s*/g, '')
  return new Set([...normalized.matchAll(/\d+(?:\.\d+)?/g)].map((m) => String(Number(m[0]))))
}
function expectGrounded(rows: GooglePricingRow[], html: string) {
  const slugs = codeSlugs(html)
  const numbers = numericTokens(html)
  for (const row of rows) {
    expect(slugs.has(row.model_slug), `slug ${row.model_slug} not in a <code> element`).toBe(true)
    for (const field of PRICE_FIELDS) {
      const value = row[field]
      if (value === null) continue
      expect(numbers.has(String(value)), `${row.model_slug} ${field}=${value} not printed`).toBe(
        true,
      )
    }
  }
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

describe('parseGooglePricing on the 2026-08-25 fixture', () => {
  const { rows, skipped } = parseGooglePricingPage(fixture, FIXTURE_PROV)
  const byKey = new Map(rows.map((r) => [rowKey(r), r]))

  it('reproduces every hand-verified ground-truth row, and nothing else', () => {
    const misses: string[] = []
    for (const want of expected.rows) {
      const got = byKey.get(rowKey(want))
      if (!got) {
        misses.push(`missing ${rowKey(want)}`)
        continue
      }
      for (const field of PRICE_FIELDS) {
        if (got[field] !== want[field]) {
          misses.push(`${rowKey(want)} ${field}: got ${got[field]}, expected ${want[field]}`)
        }
      }
    }
    expect(misses).toEqual([])
    expect(rows).toHaveLength(expected.rows.length)
    expect(expected.rows).toHaveLength(90)
  })

  it('validates against the row contract and stamps the provenance it was handed', () => {
    expect(GooglePricingOutput.safeParse({ rows }).success).toBe(true)
    for (const row of rows) {
      expect(row.provider).toBe('google')
      expect(row.currency).toBe('USD')
      expect(row.source_url).toBe(FIXTURE_PROV.source_url)
      expect(row.fetched_at).toBe(FIXTURE_PROV.fetched_at)
    }
  })

  it('is grounded: every slug is a <code> string, every price is printed on the page', () => {
    expectGrounded(rows, fixture)
  })

  it('reports every section it did not price, with a reason', () => {
    expect(skipped.map((s) => s.slug)).toEqual([
      'imagen-4',
      'veo-3.1',
      'veo-3',
      'veo-2',
      'lyria-3',
      'gemma-4',
      'pricing-for-tools',
      'pricing-for-agents',
      'notes',
    ])
    expect(skipped.find((s) => s.slug === 'imagen-4')?.reason).toMatch(/per Image in USD/)
    expect(skipped.find((s) => s.slug === 'veo-3')?.reason).toMatch(/per second in USD/)
    expect(skipped.find((s) => s.slug === 'gemma-4')?.reason).toMatch(/no <code> model id/)
    expect(skipped.find((s) => s.slug === 'notes')?.reason).toBe('no pricing table')
  })

  it('splits a dual-date promo cell into a current row and a scheduled row', () => {
    const current = byKey.get('gemini-3.6-flash|standard|null|2027-01-01')
    const scheduled = byKey.get('gemini-3.6-flash|standard|2027-01-01|null')
    expect(current).toMatchObject({
      input_per_mtok: 0.75,
      cached_input_per_mtok: 0.075,
      output_per_mtok: 3.75,
      effective_from: null,
      effective_until: '2027-01-01',
    })
    expect(scheduled).toMatchObject({
      input_per_mtok: 1.5,
      cached_input_per_mtok: 0.15,
      output_per_mtok: 7.5,
      effective_from: '2027-01-01',
      effective_until: null,
    })
    expect(current?.notes).toContain('input: $0.75 through December 31, 2026.')
    // Current row immediately precedes its scheduled row, in page order.
    const i = rows.indexOf(current!)
    expect(rows[i + 1]).toBe(scheduled)
  })

  it('never puts a per-image price in a per-MTok field: null plus the printed text', () => {
    const row = byKey.get('gemini-2.5-flash-image|standard|null|null')!
    expect(row.input_per_mtok).toBe(0.3)
    expect(row.output_per_mtok).toBeNull()
    expect(row.notes).toBe('input: $0.30 (text / image); output: $0.039 per image*')
  })

  it('takes the first printed price on conditional cells and keeps the rest in notes', () => {
    const pro = byKey.get('gemini-2.5-pro|standard|null|null')!
    expect(pro.input_per_mtok).toBe(1.25)
    expect(pro.output_per_mtok).toBe(10)
    expect(pro.cached_input_per_mtok).toBe(0.125)
    expect(pro.notes).toContain(
      'input: $1.25, prompts <= 200k tokens | $2.50, prompts > 200k tokens',
    )
    const audio = byKey.get('gemini-2.5-flash-native-audio-preview-12-2025|null|null|null')!
    expect(audio.input_per_mtok).toBe(0.5)
    expect(audio.output_per_mtok).toBe(2)
    expect(audio.notes).toBe(
      'input: $0.50 (text) | $3.00 (audio / video); output: $2.00 (text) | $12.00 (audio)',
    )
  })

  it('keeps sub-cent precision and "Not available" as null without a note', () => {
    const lite = byKey.get('gemini-2.0-flash-lite|standard|null|null')!
    expect(lite.input_per_mtok).toBe(0.075)
    expect(lite.cached_input_per_mtok).toBeNull()
    expect(lite.notes).toBeNull()
    expect(byKey.get('gemini-3.1-flash-lite|batch|null|null')?.cached_input_per_mtok).toBe(0.0125)
  })

  it('prices a heading that prints two codes once per code', () => {
    const pro = rows.filter((r) => r.model_slug === 'gemini-3.1-pro-preview')
    const tools = rows.filter((r) => r.model_slug === 'gemini-3.1-pro-preview-customtools')
    expect(pro).toHaveLength(4)
    expect(tools.map((r) => [r.tier, ...PRICE_FIELDS.map((f) => r[f])])).toEqual(
      pro.map((r) => [r.tier, ...PRICE_FIELDS.map((f) => r[f])]),
    )
  })

  it('is deterministic', async () => {
    const a = await sha256(parseGooglePricing(fixture, FIXTURE_PROV))
    const b = await sha256(parseGooglePricing(fixture, FIXTURE_PROV))
    expect(a).toBe(b)
  })
})

describe('parseGooglePricing on the 2026-09-07 page', () => {
  const { rows, skipped } = parseGooglePricingPage(live, LIVE_PROV)
  const byKey = new Map(rows.map((r) => [rowKey(r), r]))

  it('parses the newer page without being tuned to it', () => {
    expect(rows).toHaveLength(95)
    expect(GooglePricingOutput.safeParse({ rows }).success).toBe(true)
    expectGrounded(rows, live)
    // Sections skipped are exactly the non-token ones; the models the page
    // dropped since August (imagen-4, veo-3, veo-2) are simply absent.
    expect(skipped.map((s) => s.slug)).toEqual([
      'veo-3.1',
      'lyria-3-5',
      'lyria-3',
      'gemma-4',
      'pricing-for-tools',
      'pricing-for-agents',
      'notes',
    ])
  })

  it('picks up the models added since the fixture', () => {
    expect(byKey.get('gemini-3.8-flash|standard|null|2027-01-01')).toMatchObject({
      input_per_mtok: 0.75,
      cached_input_per_mtok: 0.075,
      output_per_mtok: 3.75,
    })
    expect(byKey.get('gemini-3.8-flash|standard|2027-01-01|null')).toMatchObject({
      input_per_mtok: 1.5,
      output_per_mtok: 7.5,
    })
    expect(byKey.get('gemini-omni-1.1-flash|standard|null|null')).toMatchObject({
      input_per_mtok: 1.5,
      output_per_mtok: 9,
    })
    // These two were in the CSV ground truth (from a 2026-08-26 poll) but not
    // in the 2026-08-25 fixture; the expected.json header records why.
    expect(byKey.get('gemini-3.5-transcribe|standard|null|null')).toMatchObject({
      input_per_mtok: 2,
      cached_input_per_mtok: null,
      output_per_mtok: 12,
    })
    expect(byKey.get('gemini-3.5-transcribe-live|standard|null|null')).toMatchObject({
      input_per_mtok: 3.5,
      cached_input_per_mtok: null,
      output_per_mtok: 21,
    })
  })
})

describe('parseGooglePricing structure guards', () => {
  it('fails loudly when the page has no model sections at all', () => {
    expect(() =>
      parseGooglePricing('<html><body><p>moved</p></body></html>', FIXTURE_PROV),
    ).toThrow(/no <h2 id/)
  })

  it('reports a section whose table shape it does not recognise instead of dropping it', () => {
    const page = `
      <h2 id="gemini-x">Gemini X</h2><em><code>gemini-x</code></em>
      <h3>Standard</h3>
      <table><thead><tr><th></th><th>Free Tier</th><th>Paid Tier, per 1M tokens in USD</th></tr></thead>
      <tbody><tr><td>Input price</td><td>$1.00</td></tr></tbody></table>
      <h2 id="gemini-y">Gemini Y</h2><em><code>gemini-y</code></em>
      <table><thead><tr><th></th><th>Free Tier</th><th>Paid Tier, per 1M tokens in USD</th></tr></thead>
      <tbody><tr><td>Input price</td><td>Not available</td><td>$2.00</td></tr>
      <tr><td>Output price</td><td>Not available</td><td>$4 (text)<br>$8 (audio)</td></tr></tbody></table>`
    const { rows, skipped } = parseGooglePricingPage(page, FIXTURE_PROV)
    expect(skipped).toEqual([
      { slug: 'gemini-x', reason: 'standard table: row has 2 cells, header has 3' },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      model_slug: 'gemini-y',
      tier: null,
      input_per_mtok: 2,
      output_per_mtok: 4,
      notes: 'output: $4 (text) | $8 (audio)',
    })
  })

  it('reports a promo cell missing its second half as null rather than guessing', () => {
    const page = `
      <h2 id="gemini-z">Gemini Z</h2><em><code>gemini-z</code></em>
      <table><thead><tr><th></th><th>Free Tier</th><th>Paid Tier, per 1M tokens in USD</th></tr></thead>
      <tbody><tr><td>Input price</td><td>Not available</td><td>$1.00 through March 31, 2027.</td></tr></tbody></table>`
    const { rows } = parseGooglePricingPage(page, FIXTURE_PROV)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      input_per_mtok: null,
      effective_from: null,
      effective_until: null,
      notes: 'input: $1.00 through March 31, 2027.',
    })
  })
})
