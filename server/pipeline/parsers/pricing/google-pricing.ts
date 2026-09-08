import type { z } from 'zod'
import { GooglePricingOutput as ContractGooglePricingOutput, registerParser } from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'

// google-pricing — https://ai.google.dev/gemini-api/docs/pricing
//
// Deterministic replacement for the take-home's agent lane. The page is
// server-rendered and regular: one `<h2 id="<slug>">` per model, the API code
// in a `<code>` element directly under it, then one `<table>` per tier under
// an `<h3>` (Standard / Batch / Flex / Priority). Every table is three columns
// (label, Free Tier, Paid Tier) and the Paid Tier header names the unit —
// "per 1M tokens in USD" for the tables this parser reads; per image / per
// second / per request for the ones it reports as skipped.
//
// No DOM library: tags are scanned with regexes over the raw string. The page
// prints unescaped `<= 200k tokens` inside cells, so the tag regex only
// accepts `<` followed by a letter or `/`.
//
// Honesty rules, in order of precedence:
//   1. A slug is only ever the verbatim text of a <code> element.
//   2. A price is only ever a `$` amount printed in the cell; a cell that
//      prints no per-token amount yields null and a note carrying its text.
//   3. A section or table whose structure is not recognised is reported in
//      `skipped`, never dropped. Partial extraction that looks complete was
//      the failure the agent lane had.
//   4. Provenance is an argument. Nothing here reads a clock.

// The row shape is the shared PriceRow with provider pinned to "google" —
// the same schema the take-home's agent lane had to pass. Exported under the
// lane's own names so callers and tests read naturally.
export const GooglePricingOutput = ContractGooglePricingOutput
export const GooglePricingRow = GooglePricingOutput.shape.rows.element
export type GooglePricingRow = z.infer<typeof GooglePricingRow>

export interface Provenance {
  source_url: string
  fetched_at: string
}

/** A model section (or one tier table inside it) the parser did not turn
 * into rows, with the reason. Callers must surface these. */
export interface SkippedSection {
  slug: string
  reason: string
}

export interface GooglePricingResult {
  rows: GooglePricingRow[]
  skipped: SkippedSection[]
}

type PriceField = 'input_per_mtok' | 'cached_input_per_mtok' | 'output_per_mtok'

const TOKEN_HEADER = 'Paid Tier, per 1M tokens in USD'

// Row labels the page uses for the three per-MTok fields. Anything else
// (grounding, tuning, storage-only, per-modality input rows on the embedding
// model, "Used to improve our products") is not a per-MTok price.
const FIELD_BY_LABEL: Record<string, PriceField> = {
  'Input price': 'input_per_mtok',
  'Input price (text, image, video)': 'input_per_mtok',
  'Text input price': 'input_per_mtok',
  'Output price': 'output_per_mtok',
  'Output price (including thinking tokens)': 'output_per_mtok',
  'Context caching price': 'cached_input_per_mtok',
}

const NOTE_PREFIX: Record<PriceField, string> = {
  input_per_mtok: 'input',
  cached_input_per_mtok: 'cached_input',
  output_per_mtok: 'output',
}

const H2 = /<h2 id="([^"]+)"/g
const CODE = /<code[^>]*>([^<]+)<\/code>/g
const H3_OR_TABLE = /<h3[^>]*>([^<]*)<\/h3>|<table[\s\S]*?<\/table>/g
const TH = /<th[^>]*>([\s\S]*?)<\/th>/g
const TR = /<tr[^>]*>([\s\S]*?)<\/tr>/g
const TD = /<td[^>]*>([\s\S]*?)<\/td>/g
const BR = /<br\s*\/?>/g
// `<` followed by a letter or `/` only — the page prints a literal "<= 200k".
const TAG = /<\/?[a-zA-Z][^>]*>/g
const FOOTNOTE = /<sup>[^<]*<\/sup>/g

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&#39;': "'",
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
}

const MONTHS: Record<string, string> = {
  January: '01',
  February: '02',
  March: '03',
  April: '04',
  May: '05',
  June: '06',
  July: '07',
  August: '08',
  September: '09',
  October: '10',
  November: '11',
  December: '12',
}

function text(fragment: string): string {
  return fragment
    .replace(FOOTNOTE, '')
    .replace(TAG, '')
    .replace(/&[a-z#0-9]+;/g, (e) => ENTITIES[e] ?? e)
    .replace(/\s+/g, ' ')
    .trim()
}

/** A cell's visible lines: split on <br>, footnote markers removed. */
function cellLines(fragment: string): string[] {
  return fragment
    .split(BR)
    .map(text)
    .filter((l) => l.length > 0)
}

/** "December 31, 2026" -> "2026-12-31"; null for anything else. */
function isoDate(printed: string): string | null {
  const m = printed.match(/^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/)
  if (!m) return null
  const month = MONTHS[m[1]!]
  if (!month) return null
  return `${m[3]}-${month}-${m[2]!.padStart(2, '0')}`
}

const LEADING_AMOUNT = /^\$(\d[\d,]*(?:\.\d+)?)(.*)$/
// What may follow an amount and still leave it a per-MTok price: a modality
// qualifier, a prompt-size conditional, an "or $X/min" equivalent, or an
// explicit "/ 1,000,000 tokens". These are NOT per-MTok:
const NON_TOKEN_UNIT =
  /^\s*(?:per\s|\/\s*(?:min|minute|sec|second|hr|hour|image|request|song|frame)\b|\/\s*1,000,000 tokens per hour)/

/** The amount a line prints as its per-MTok price, or null when the line
 * does not open with one or opens with a per-image / per-second / storage
 * amount. Sub-cent precision is kept: "$0.075" -> 0.075. */
function lineAmount(line: string): number | null {
  const m = line.match(LEADING_AMOUNT)
  if (!m) return null
  if (NON_TOKEN_UNIT.test(m[2]!)) return null
  return Number(m[1]!.replace(/,/g, ''))
}

function firstAmount(lines: readonly string[]): number | null {
  for (const line of lines) {
    const amount = lineAmount(line)
    if (amount !== null) return amount
  }
  return null
}

const THROUGH = /\bthrough ([A-Z][a-z]+ \d{1,2}, \d{4})\.?$/
const STARTING = /\bstarting ([A-Z][a-z]+ \d{1,2}, \d{4})\.?$/
const NOT_AVAILABLE = /^not available\b/i

interface ParsedCell {
  /** Price in force now (the "through" price on a promo cell). */
  value: number | null
  /** Scheduled price and the date it starts; both null on a plain cell. */
  next: number | null
  next_from: string | null
  note: string | null
}

function parseCell(field: PriceField, lines: readonly string[]): ParsedCell {
  const printed = lines.join(' | ')
  const note = `${NOTE_PREFIX[field]}: ${printed}`
  if (lines.length === 0 || lines.every((l) => NOT_AVAILABLE.test(l))) {
    return { value: null, next: null, next_from: null, note: null }
  }

  const through = lines.filter((l) => THROUGH.test(l))
  const starting = lines.filter((l) => STARTING.test(l))
  if (through.length > 0 || starting.length > 0) {
    const dates = new Set(starting.map((l) => isoDate(l.match(STARTING)![1]!)))
    const next_from = dates.size === 1 ? [...dates][0]! : null
    if (next_from === null || through.length === 0) {
      // A promo cell missing one of its two halves: report, do not guess.
      return { value: null, next: null, next_from: null, note }
    }
    return { value: firstAmount(through), next: firstAmount(starting), next_from, note }
  }

  const value = firstAmount(lines)
  // A bare "$X" needs no note; anything else printed alongside travels.
  const bare = lines.length === 1 && /^\$\d[\d,]*(?:\.\d+)?$/.test(lines[0]!)
  return { value, next: null, next_from: null, note: bare ? null : note }
}

type TableParse =
  | { kind: 'token'; cells: Map<PriceField, ParsedCell> }
  | { kind: 'skip'; reason: string }

function parseTable(tableHtml: string): TableParse {
  const headers = [...tableHtml.matchAll(TH)].map((m) => text(m[1]!))
  const paidCol = headers.indexOf(TOKEN_HEADER)
  if (paidCol === -1) {
    const unit = headers.filter((h) => h.length > 0).join(' / ') || '(no header)'
    return { kind: 'skip', reason: `not a per-1M-token table (header: ${unit})` }
  }

  const cells = new Map<PriceField, ParsedCell>()
  for (const tr of tableHtml.matchAll(TR)) {
    const tds = [...tr[1]!.matchAll(TD)].map((m) => m[1]!)
    if (tds.length === 0) continue // header row
    if (tds.length !== headers.length) {
      return { kind: 'skip', reason: `row has ${tds.length} cells, header has ${headers.length}` }
    }
    const field = FIELD_BY_LABEL[text(tds[0]!)]
    if (!field) continue
    if (cells.has(field)) {
      return { kind: 'skip', reason: `two rows map to ${field}` }
    }
    cells.set(field, parseCell(field, cellLines(tds[paidCol]!)))
  }
  if (cells.size === 0) {
    return { kind: 'skip', reason: 'no input / output / context-caching rows' }
  }
  return { kind: 'token', cells }
}

const FIELDS: readonly PriceField[] = ['input_per_mtok', 'cached_input_per_mtok', 'output_per_mtok']

interface RowCore {
  tier: string | null
  prices: Record<PriceField, number | null>
  effective_from: string | null
  effective_until: string | null
  notes: string | null
}

/** One table -> one row, or two when any cell schedules a price change. */
function tableRows(tier: string | null, cells: Map<PriceField, ParsedCell>): RowCore[] | string {
  const changeDates = new Set<string>()
  for (const cell of cells.values()) if (cell.next_from) changeDates.add(cell.next_from)
  if (changeDates.size > 1) {
    return `promo cells disagree on the change date: ${[...changeDates].join(', ')}`
  }
  const next_from = changeDates.size === 1 ? [...changeDates][0]! : null

  const notes = FIELDS.map((f) => cells.get(f)?.note)
    .filter((n): n is string => typeof n === 'string')
    .join('; ')
  const pick = (f: PriceField, scheduled: boolean): number | null => {
    const cell = cells.get(f)
    if (!cell) return null
    return scheduled && cell.next_from ? cell.next : cell.value
  }
  const prices = (scheduled: boolean) =>
    Object.fromEntries(FIELDS.map((f) => [f, pick(f, scheduled)])) as Record<
      PriceField,
      number | null
    >

  const current: RowCore = {
    tier,
    prices: prices(false),
    effective_from: null,
    effective_until: next_from,
    notes: notes || null,
  }
  if (next_from === null) return [current]
  return [
    current,
    { tier, prices: prices(true), effective_from: next_from, effective_until: null, notes },
  ]
}

interface Section {
  id: string
  html: string
}

function splitSections(html: string): Section[] {
  const heads = [...html.matchAll(H2)]
  return heads.map((head, i) => ({
    id: head[1]!,
    html: html.slice(head.index!, heads[i + 1]?.index ?? html.length),
  }))
}

/**
 * Parse the Gemini API pricing page. `prov` is stamped verbatim onto every
 * row. Rows come back in page order (model, then tier, a current-window row
 * immediately before its scheduled one); `skipped` lists every section or
 * tier table that produced no rows, with the reason.
 *
 * Throws only when the page has no `<h2 id>` sections at all — a page whose
 * structure vanished must fail loudly rather than emit an empty snapshot.
 */
export function parseGooglePricingPage(html: string, prov: Provenance): GooglePricingResult {
  const sections = splitSections(html)
  if (sections.length === 0) {
    throw new Error(
      'google-pricing: no <h2 id="..."> model sections found — page structure changed',
    )
  }

  const rows: GooglePricingRow[] = []
  const skipped: SkippedSection[] = []

  for (const section of sections) {
    const firstTable = section.html.indexOf('<table')
    if (firstTable === -1) {
      skipped.push({ slug: section.id, reason: 'no pricing table' })
      continue
    }
    const slugs = [...section.html.slice(0, firstTable).matchAll(CODE)].map((m) => m[1]!.trim())
    if (slugs.length === 0) {
      skipped.push({ slug: section.id, reason: 'no <code> model id under the heading' })
      continue
    }

    const cores: RowCore[] = []
    const tableSkips: string[] = []
    let tier: string | null = null
    for (const part of section.html.matchAll(H3_OR_TABLE)) {
      if (part[0].startsWith('<h3')) {
        tier = text(part[1]!).toLowerCase()
        continue
      }
      const parsed = parseTable(part[0])
      if (parsed.kind === 'skip') {
        tableSkips.push(`${tier ?? 'untiered'} table: ${parsed.reason}`)
        continue
      }
      const built = tableRows(tier, parsed.cells)
      if (typeof built === 'string') {
        tableSkips.push(`${tier ?? 'untiered'} table: ${built}`)
        continue
      }
      cores.push(...built)
    }

    for (const reason of tableSkips) skipped.push({ slug: section.id, reason })
    // A heading that prints several codes prices them identically.
    for (const slug of slugs) {
      for (const core of cores) {
        rows.push({
          provider: 'google',
          model_slug: slug,
          tier: core.tier,
          context_window: null,
          ...core.prices,
          currency: 'USD',
          effective_from: core.effective_from,
          effective_until: core.effective_until,
          notes: core.notes,
          source_url: prov.source_url,
          fetched_at: prov.fetched_at,
        })
      }
    }
  }

  return { rows: GooglePricingOutput.parse({ rows }).rows, skipped }
}

/** Rows only. Prefer parseGooglePricingPage where `skipped` can be surfaced. */
export function parseGooglePricing(html: string, prov: Provenance): GooglePricingRow[] {
  return parseGooglePricingPage(html, prov).rows
}

// Registered so the determinism harness runs it twice on its fixture like every
// other fixed parser. Until 2026-09-07 this source was agent-parsed and stayed
// out of the registry on purpose; it is deterministic now.
registerParser({
  name: 'google-pricing-html',
  lane: 'vendor-md',
  fixturePath: 'fixtures/pricing/google-pricing.html',
  sideFixturePaths: [],
  schema: GooglePricingOutput,
  parse: (html) => ({ rows: parseGooglePricing(html, fixtureProvenance('google-pricing-html')) }),
})
