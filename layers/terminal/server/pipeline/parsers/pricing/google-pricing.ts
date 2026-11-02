import type { z } from 'zod'
import { GooglePricingOutput as ContractGooglePricingOutput, registerParser } from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'

// google-pricing — https://aistudio.google.com/docs/pricing.md
//
// Deterministic parse — no model in the loop. Two renderings of one page, told
// apart by their headings:
//
//   Markdoc (from 2026-11-02, when ai.google.dev/gemini-api/docs/pricing began
//   301-ing to a client-rendered AI Studio page): one `## Name {% id="<slug>" %}`
//   per model, the API code(s) in backticks inside the `{% left-column %}` under
//   it, then one `{% table %}` per tier inside a `{% tab title="Standard" %}`.
//   Rows are separated by `---` lines and cells open with `* `; a line ending in
//   two or more spaces is a hard break, the <br> of the HTML rendering.
//
//   SSR HTML (until 2026-11-02): one `<h2 id="<slug>">` per model, the API code
//   in a `<code>` element directly under it, then one `<table>` per tier under
//   an `<h3>`. Kept because the hand-verified ground truth is on that fixture.
//
// Either way every table is three columns (label, Free Tier, Paid Tier) and the
// Paid Tier header names the unit — "per 1M tokens in USD" for the tables this
// parser reads; per image / per second / per request for the ones it reports
// as skipped. Tiers are Standard / Batch / Flex / Priority / Contributor.
//
// No DOM or Markdown library: both are scanned with regexes over the raw
// string. The page prints unescaped `<= 200k tokens` inside cells, so the HTML
// tag regex only accepts `<` followed by a letter or `/`.
//
// Honesty rules, in order of precedence:
//   1. A slug is only ever the verbatim text of a <code> element (HTML) or a
//      backtick span in the heading's left column (Markdoc).
//   2. A price is only ever a `$` amount printed in the cell; a cell that
//      prints no per-token amount yields null and a note carrying its text.
//   3. A section or table whose structure is not recognised is reported in
//      `skipped`, never dropped. Partial extraction that looks complete is
//      the failure mode a model-driven extractor had on this page.
//   4. Provenance is an argument. Nothing here reads a clock.

// The row shape is the shared PriceRow with provider pinned to "google".
// Exported under the lane's own names so callers and tests read naturally.
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

const MD_H2 = /^## .*\{% id="([^"]+)" %\}[ \t]*$/gm
const MD_LEFT_COLUMN = /\{% left-column[^%]*%\}([\s\S]*?)\{% \/left-column %\}/
const MD_CODE = /`([^`\n]+)`/g
const MD_TAB_OR_TABLE =
  /\{% tab title="([^"]*)" %\}|\{% \/tab %\}|\{% table %\}([\s\S]*?)\{% \/table %\}/g
const MD_ROW_RULE = /^[ \t]*---[ \t]*$/m
const MD_CELL = /^[ \t]*\* (.*)$/
const MD_HARD_BREAK = /(?: {2,}|\\)$/
const MD_SUP = /\{% sup %\}[\s\S]*?\{% \/sup %\}/g
const MD_TAG = /\{%[\s\S]*?%\}/g
const MD_LINK = /\[([^\]]*)\]\([^)]*\)/g

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

/** One visible Markdoc line as the HTML rendering's text() would print it. */
function mdText(fragment: string): string {
  return fragment
    .replace(MD_SUP, '')
    .replace(MD_TAG, '')
    .replace(MD_LINK, '$1')
    .replace(/\*\*/g, '')
    .replace(/(^|[^\\])\*([^*\s][^*]*)\*/g, '$1$2')
    .replace(/`/g, '')
    .replace(/\\([\\`*_[\]])/g, '$1')
    .replace(/&[a-z#0-9]+;/g, (e) => ENTITIES[e] ?? e)
    .replace(/\s+/g, ' ')
    .trim()
}

/** One `---`-delimited Markdoc row -> its cells, each as visible lines. A
 * soft-wrapped source line joins the line before it; a hard break (trailing
 * spaces, or the trailing backslash some cards use) or a blank line ends it. */
function mdRowCells(chunk: string): string[][] {
  const cells: string[][] = []
  let cell: string[] | null = null
  let buffer: string[] = []
  const flush = () => {
    const line = mdText(buffer.join(' '))
    if (cell && line.length > 0) cell.push(line)
    buffer = []
  }
  for (const raw of chunk.split('\n')) {
    const broken = MD_HARD_BREAK.test(raw)
    const line = raw.replace(/\\+$/, '')
    const opened = line.match(MD_CELL)
    if (opened) {
      flush()
      cell = []
      cells.push(cell)
      buffer.push(opened[1]!)
    } else if (line.trim().length === 0) {
      flush()
      continue
    } else if (cell) {
      buffer.push(line.trim())
    }
    if (broken) flush()
  }
  flush()
  return cells
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

/** A table in either rendering: header texts, then body rows of cells of
 * visible lines. */
interface Table {
  headers: string[]
  rows: string[][][]
}

function htmlTable(tableHtml: string): Table {
  const headers = [...tableHtml.matchAll(TH)].map((m) => text(m[1]!))
  const rows = [...tableHtml.matchAll(TR)]
    .map((tr) => [...tr[1]!.matchAll(TD)].map((m) => cellLines(m[1]!)))
    .filter((tds) => tds.length > 0) // header row
  return { headers, rows }
}

function markdownTable(body: string): Table {
  const [head = [], ...rows] = body
    .split(MD_ROW_RULE)
    .map(mdRowCells)
    .filter((cells) => cells.length > 0)
  return { headers: head.map((lines) => lines.join(' ')), rows }
}

function parseTable({ headers, rows }: Table): TableParse {
  const paidCol = headers.indexOf(TOKEN_HEADER)
  if (paidCol === -1) {
    const unit = headers.filter((h) => h.length > 0).join(' / ') || '(no header)'
    return { kind: 'skip', reason: `not a per-1M-token table (header: ${unit})` }
  }

  const cells = new Map<PriceField, ParsedCell>()
  for (const tds of rows) {
    if (tds.length !== headers.length) {
      return { kind: 'skip', reason: `row has ${tds.length} cells, header has ${headers.length}` }
    }
    const field = FIELD_BY_LABEL[tds[0]!.join(' ')]
    if (!field) continue
    if (cells.has(field)) {
      return { kind: 'skip', reason: `two rows map to ${field}` }
    }
    cells.set(field, parseCell(field, tds[paidCol]!))
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

/** In page order: a tier heading or tab (null when a tab closes), or a table. */
type Part = { tier: string | null } | { table: Table }

/** One model section, or the reason it cannot be priced. */
type Section = { id: string; skip: string } | { id: string; slugs: string[]; parts: Part[] }

/** Each `<h2 id>` section up to the next. Sections are cut at the heading, so
 * a section's codes are the ones above its first table. */
function htmlSections(html: string): Section[] {
  const heads = [...html.matchAll(H2)]
  return heads.map((head, i): Section => {
    const id = head[1]!
    const body = html.slice(head.index!, heads[i + 1]?.index ?? html.length)
    const firstTable = body.indexOf('<table')
    if (firstTable === -1) return { id, skip: 'no pricing table' }
    const slugs = [...body.slice(0, firstTable).matchAll(CODE)].map((m) => m[1]!.trim())
    if (slugs.length === 0) return { id, skip: 'no <code> model id under the heading' }
    const parts = [...body.matchAll(H3_OR_TABLE)].map((m): Part =>
      m[0].startsWith('<h3') ? { tier: text(m[1]!).toLowerCase() } : { table: htmlTable(m[0]) },
    )
    return { id, slugs, parts }
  })
}

/** Each `## … {% id %}` section up to the next. Codes come from the heading's
 * left column only: a deprecation callout further down names other models in
 * backticks too. */
function markdownSections(md: string): Section[] {
  const heads = [...md.matchAll(MD_H2)]
  return heads.map((head, i): Section => {
    const id = head[1]!
    const body = md.slice(head.index!, heads[i + 1]?.index ?? md.length)
    if (!body.includes('{% table %}')) return { id, skip: 'no pricing table' }
    const column = body.match(MD_LEFT_COLUMN)?.[1] ?? ''
    const slugs = [...new Set([...column.matchAll(MD_CODE)].map((m) => m[1]!.trim()))]
    if (slugs.length === 0) return { id, skip: 'no `code` model id under the heading' }
    const parts = [...body.matchAll(MD_TAB_OR_TABLE)].map((m): Part => {
      if (m[1] !== undefined) return { tier: m[1].toLowerCase() }
      if (m[2] === undefined) return { tier: null }
      return { table: markdownTable(m[2]) }
    })
    return { id, slugs, parts }
  })
}

/**
 * Parse the Gemini API pricing page, in either rendering. `prov` is stamped
 * verbatim onto every row. Rows come back in page order (model, then tier, a
 * current-window row immediately before its scheduled one); `skipped` lists
 * every section or tier table that produced no rows, with the reason.
 *
 * Throws only when the page has no model sections at all — a page whose
 * structure vanished must fail loudly rather than emit an empty snapshot.
 */
export function parseGooglePricingPage(page: string, prov: Provenance): GooglePricingResult {
  const sections = page.includes('{% id="') ? markdownSections(page) : htmlSections(page)
  if (sections.length === 0) {
    throw new Error(
      'google-pricing: no `## … {% id %}` or <h2 id="..."> model sections found — page structure changed',
    )
  }

  const rows: GooglePricingRow[] = []
  const skipped: SkippedSection[] = []

  for (const section of sections) {
    if ('skip' in section) {
      skipped.push({ slug: section.id, reason: section.skip })
      continue
    }
    const { slugs } = section

    const cores: RowCore[] = []
    const tableSkips: string[] = []
    let tier: string | null = null
    for (const part of section.parts) {
      if ('tier' in part) {
        tier = part.tier
        continue
      }
      const parsed = parseTable(part.table)
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
export function parseGooglePricing(page: string, prov: Provenance): GooglePricingRow[] {
  return parseGooglePricingPage(page, prov).rows
}

// Registered so the determinism harness runs it twice on its fixture like every
// other fixed parser. Until 2026-09-07 this source was agent-parsed and stayed
// out of the registry on purpose; it is deterministic now. The source id keeps
// its -html suffix: its stored entities and change history are keyed on it.
registerParser({
  name: 'google-pricing-html',
  lane: 'vendor-md',
  fixturePath: 'fixtures/pricing/google-pricing.md',
  sideFixturePaths: [],
  schema: GooglePricingOutput,
  parse: (page) => ({ rows: parseGooglePricing(page, fixtureProvenance('google-pricing-html')) }),
})
