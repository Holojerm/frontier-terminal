import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { contentHash, type PriceRow } from '../../server/pipeline/contracts'
import {
  applyPriceReadings,
  checkPriceReading,
  namesModel,
  priceReview,
  type JudgePriceReading,
} from '../../server/pipeline/judge/price-review'
import { normalizePrices } from '../../server/pipeline/normalize'
import { parseAnthropicPricingMd } from '../../server/pipeline/parsers/pricing/anthropic-pricing'
import { parseMistralPricingMd } from '../../server/pipeline/parsers/pricing/mistral-pricing'
import { parseOpenAiPricingMd } from '../../server/pipeline/parsers/pricing/openai-pricing'
import { insertRows } from '../../server/pipeline/store'
import { fixtureText } from './fixtures'

// The judge reads a price list while its parser is failing; the Worker checks
// each reading against the page. The pages here are the committed fixtures,
// and the "judge" is the fixed parser: a row it reads, quoted as the line of
// the page that states it, is what a correct reading looks like.

const SOURCE = 'anthropic-pricing-md'
const URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md'
const READ_AT = '2026-10-12T18:32:54Z'
const prov = { source_url: URL, fetched_at: READ_AT }

const numbers = (line: string) =>
  [...line.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, '')))
const prices = (row: PriceRow) =>
  [row.input_per_mtok, row.cached_input_per_mtok, row.output_per_mtok].filter((p) => p !== null)

/** The line of the page that names the row's model and writes its prices. */
function lineFor(page: string, row: PriceRow): string | undefined {
  return page
    .split('\n')
    .find((l) => namesModel(l, row.model_slug) && prices(row).every((p) => numbers(l).includes(p)))
}

const reading = (row: PriceRow, quote: string, over: Partial<JudgePriceReading> = {}) => ({
  source_id: SOURCE,
  entity_key: normalizePrices([row], 's')[0]!.entity_key,
  quote,
  input_per_mtok: row.input_per_mtok,
  cached_input_per_mtok: row.cached_input_per_mtok,
  output_per_mtok: row.output_per_mtok,
  ...over,
})

describe('the checks on one reading', () => {
  it.each([
    ['fixtures/pricing/anthropic-pricing.md', parseAnthropicPricingMd],
    ['fixtures/pricing/openai-pricing.md', parseOpenAiPricingMd],
    ['fixtures/pricing/mistral-pricing.md', parseMistralPricingMd],
  ] as const)('hold for every row of %s, quoted as its line', (path, parse) => {
    const page = fixtureText(path)
    const rows = parse(page, prov).rows
    const slugs = [...new Set(rows.map((r) => r.model_slug))]
    expect(rows.length).toBeGreaterThan(5)
    for (const row of rows) {
      const line = lineFor(page, row)
      expect(line, `${row.model_slug} ${row.tier}`).toBeDefined()
      expect(checkPriceReading(reading(row, line!), page, row, slugs)).toMatchObject({ ok: true })
    }
  })

  const page = fixtureText('fixtures/pricing/anthropic-pricing.md')
  const rows = parseAnthropicPricingMd(page, prov).rows
  const slugs = [...new Set(rows.map((r) => r.model_slug))]
  const row = rows.find((r) => r.input_per_mtok !== null && r.output_per_mtok !== null)!
  const line = lineFor(page, row)!

  it('refuse a quote that is not on the page, or a price it does not write', () => {
    expect(checkPriceReading(reading(row, `${line} $1`), page, row, slugs)).toMatchObject({
      ok: false,
      reason: 'quote-not-on-page',
    })
    expect(
      checkPriceReading(reading(row, line, { output_per_mtok: 987.65 }), page, row, slugs),
    ).toMatchObject({ ok: false, reason: 'price-not-in-quote' })
  })

  it('refuse another model’s row, and a reading that blanks a price', () => {
    const other = rows.find((r) => r.model_slug !== row.model_slug && lineFor(page, r) !== line)!
    expect(checkPriceReading(reading(row, lineFor(page, other)!), page, row, slugs)).toMatchObject({
      ok: false,
    })
    expect(
      checkPriceReading(reading(row, line, { input_per_mtok: null }), page, row, slugs),
    ).toMatchObject({ ok: false, reason: 'price-columns-changed' })
  })

  it('do not take a longer-named model’s row for a shorter-named one', () => {
    const text = '| Claude Opus 5.5 | $5 / MTok | $25 / MTok |'
    expect(namesModel(text, 'claude-opus-5-5')).toBe(true)
    expect(namesModel(text, 'claude-opus-5')).toBe(false)
    const sol = '| GPT-5.6 Sol | $2.50 | $0.25 | $20.00 |'
    const known = {
      model_slug: 'gpt-5.6',
      input_per_mtok: 2.5,
      cached_input_per_mtok: 0.25,
      output_per_mtok: 20,
    }
    expect(
      checkPriceReading(
        {
          source_id: 'openai-pricing-md',
          entity_key: 'model:openai:gpt-5.6',
          quote: sol,
          ...known,
        },
        sol,
        known,
        ['gpt-5.6', 'gpt-5.6-sol'],
      ),
    ).toMatchObject({ ok: false, reason: 'quote-names-another-model', detail: 'gpt-5.6-sol' })
  })
})

describe('a price list whose parser is failing', () => {
  const db = drizzle(env.DB, { schema })
  const page = fixtureText('fixtures/pricing/anthropic-pricing.md')
  const rows = parseAnthropicPricingMd(page, prov).rows
  const moved = rows.find((r) => r.input_per_mtok !== null && r.output_per_mtok !== null)!
  const steady = rows.find((r) => r.model_slug !== moved.model_slug && lineFor(page, r))!
  // The vendor reprices one model's output on a page the parser cannot read.
  const oldLine = lineFor(page, moved)!
  const newOutput = moved.output_per_mtok! + 1234
  const newLine = oldLine.replace(
    new RegExp(
      `(?<![\\d.])${String(moved.output_per_mtok).replace('.', '\\.')}(?:\\.0+)?(?![\\d.])`,
      'g',
    ),
    String(newOutput),
  )
  const reshaped = page.replace(oldLine, newLine)
  const readRaw = async () => reshaped
  const FAILED_AT = '2026-11-10T20:00:00.000Z'
  const snapshot = {
    id: `${SOURCE}:${FAILED_AT}`,
    source_id: SOURCE,
    content_hash: contentHash({ page: 'reshaped' }),
    raw_key: 'raw/anthropic-pricing-md/reshaped.md',
    http_status: 200,
    bytes: reshaped.length,
    source_url: URL,
    fetched_at: FAILED_AT,
  }
  const run = (started_at: string, status: string) => ({
    id: `poll:${SOURCE}:${started_at}`,
    scope: 'poll',
    source_id: SOURCE,
    started_at,
    status,
    detail: status === 'failed' ? 'anthropic-pricing: no table with a Model header' : null,
    snapshot_id: snapshot.id,
    added: 0,
    removed: 0,
    modified: 0,
    source_url: URL,
    parse_basis: null,
  })
  const key = (row: PriceRow) => normalizePrices([row], 's')[0]!.entity_key
  const stored = async (row: PriceRow) => {
    const all = await db.select().from(schema.entities)
    return JSON.parse(all.find((e) => e.entity_key === key(row))!.payload) as PriceRow
  }

  beforeEach(async () => {
    for (const table of [
      schema.entities,
      schema.changes,
      schema.snapshots,
      schema.sourceRuns,
      schema.priceReadings,
      schema.opsEvents,
    ])
      await db.delete(table)
    await insertRows(
      db,
      'entities',
      normalizePrices(rows, `${SOURCE}:${READ_AT}`).map((e) => ({
        ...e,
        source_id: SOURCE,
        first_seen_at: READ_AT,
      })),
    )
    await insertRows(db, 'snapshots', [snapshot])
  })

  it('is not offered after one failed run, and is after two', async () => {
    await db.insert(schema.sourceRuns).values([run('2026-11-10T19:30:00.000Z', 'ok')])
    await db.insert(schema.sourceRuns).values([run(FAILED_AT, 'failed')])
    expect(await priceReview(db, readRaw)).toEqual([])
    await db.insert(schema.sourceRuns).values([run('2026-11-10T20:30:00.000Z', 'failed')])
    const [offer] = await priceReview(db, readRaw)
    expect(offer).toMatchObject({ source_id: SOURCE, page: reshaped })
    expect(offer!.known).toHaveLength(new Set(rows.map(key)).size)
  })

  it('stores a changed price as a change, keeps the rest, and offers the page once', async () => {
    await db
      .insert(schema.sourceRuns)
      .values([run(FAILED_AT, 'failed'), run('2026-11-10T20:30:00.000Z', 'failed')])
    const report = await applyPriceReadings(
      db,
      readRaw,
      [
        reading(moved, newLine, { output_per_mtok: newOutput }),
        reading(steady, lineFor(page, steady)!),
        // Not on the page as fetched: the old line is gone.
        { ...reading(moved, oldLine), entity_key: 'model:anthropic:not-listed' },
      ],
      new Date('2026-11-10T21:17:00Z'),
    )
    expect(report).toMatchObject({
      accepted: 2,
      changed: 1,
      rejected: [{ reason: 'not-a-listed-sku' }],
    })
    expect((await stored(moved)).output_per_mtok).toBe(newOutput)
    expect((await stored(moved)).input_per_mtok).toBe(moved.input_per_mtok)
    expect((await stored(steady)).output_per_mtok).toBe(steady.output_per_mtok)
    expect(await db.select().from(schema.entities)).toHaveLength(new Set(rows.map(key)).size)

    const changes = await db.select().from(schema.changes)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      entity_key: key(moved),
      change_type: 'modified',
      source_url: URL,
      fetched_at: FAILED_AT,
    })
    const [read] = await db.select().from(schema.priceReadings)
    expect(read).toMatchObject({ source_id: SOURCE, confirmed: 1, changed: 1 })
    expect(JSON.parse(read!.readings)).toMatchObject([{ entity_key: key(moved) }])
    const ops = await db.select().from(schema.opsEvents)
    expect(ops.map((o) => o.kind)).toEqual(['price_read_by_judge'])

    expect(await priceReview(db, readRaw)).toEqual([])
    expect(
      await applyPriceReadings(db, readRaw, [reading(steady, lineFor(page, steady)!)], new Date()),
    ).toMatchObject({ accepted: 0, rejected: [{ reason: 'not-offered' }] })
  })

  it('refuses every reading for a source that is parsing', async () => {
    await db
      .insert(schema.sourceRuns)
      .values([run(FAILED_AT, 'failed'), run('2026-11-10T20:30:00.000Z', 'ok')])
    expect(
      await applyPriceReadings(db, readRaw, [reading(steady, lineFor(page, steady)!)], new Date()),
    ).toMatchObject({ accepted: 0, changed: 0, rejected: [{ reason: 'not-offered' }] })
  })
})
