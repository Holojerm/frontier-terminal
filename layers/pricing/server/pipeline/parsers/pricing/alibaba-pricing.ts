import {
  registerParser,
  VendorMdPricingOutput,
  type PriceRow,
  type Provenance,
} from '../../../../../core/server/utils/contracts'
import { textOf } from '../../../../../core/server/pipeline/parsers/html-text'
import { fixtureProvenance } from '../../../../../core/server/utils/fixture-provenance'

// alibaba-pricing-html — www.alibabacloud.com/help/en/model-studio/model-pricing
// Alibaba Cloud's international site: server-rendered HTML, one <h3> per model line and one
// <h4> tab per region under it, each a table priced in USD per million tokens. Read only:
//
//   - the "Text generation - Qwen" section, lines Qwen-Max, Qwen-Plus and Qwen-Flash (the
//     commercial text lines the class map draws from). The specialised lines (Omni, VL, OCR,
//     Coder, Translation, …), the open-weight section and the "third-party models" section
//     (DeepSeek, Kimi, GLM, MiniMax, which Alibaba resells) are not Alibaba's list price for
//     a Qwen text model;
//   - the Singapore tab's "International" deployment rows: the international list price.
//     Beijing, Hong Kong, Frankfurt, Virginia and Tokyo print other prices for the same ids.
//
// Alibaba republishes the page as a fresh machine translation now and then ("Input price"
// became "Input unit price"; #427), so headings and column labels match on their words, not
// their punctuation or casing. A heading or label that matches nothing, or more than one
// thing, still fails the parse.
//
// A table's header is its <thead> or, as in the Qwen Flash Singapore table, its first <tbody>
// row. That table's "Pattern" column is filled by only some rows; the others print their band
// there, so a positional read would store the band's neighbour as the input price. A row is
// read under the header only when its own cells fit it (an id in the model cell, a band in
// the band cell), or under the header without Pattern when it fits that cell for cell. Any
// other International row fails the parse: this is a 'set' lane, where a row left out would
// be recorded as the model being delisted.
//
// A model is tiered by input tokens per request ("0<Token≤256K", "256K<Token≤1M"): the first
// band is the standard row, each later band its own tier (`input_256k_1m`), as OpenAI's
// long-context rows are. Where a table prices non-thinking and thinking output apart, the
// non-thinking price is the output price and the thinking one goes in notes. An "Original$X
// (N% off for a limited time)" cell stores X and notes the promotion; the page states no end
// date, so no effective_until is set. Most cache and batch discounts are percentages on other
// pages and are not read. The exception is a tab that prints its own cache price table under a
// "<slug> — Cache unit prices (per million tokens)" caption (qwen4-max, #405): its cache hit
// is the cached-input price and its 5m and 1h cache creations go in notes, as Anthropic's are.

const SECTION = 'Text generation - Qwen'
const LINES = ['Qwen-Max', 'Qwen-Plus', 'Qwen-Flash'] as const
const REGION = 'Singapore'
const SCOPE = 'International'

const SLUG = /^[a-z0-9][a-z0-9.-]*$/
const BAND = /^(\d+[KM]?)<Token≤(\d+[KM])$/
const NO_TIERS = /^no tiered pricing$/i
const PRICE = /^(?:(?:list price|original)\s*)?\$(\d+(?:\.\d+)?)(?:\s*\((.+?)\)?)?$/i
const QUOTA = /^\d+ million tokens$/i

export interface Cell {
  html: string
  text: string
}

/** Lowercase words only: "Qwen-Max", "Qwen Max" and "qwen  max" are one heading. */
function words(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Every heading of one level with its text and where it starts. */
function headings(html: string, level: number): { text: string; at: number }[] {
  const re = new RegExp(`<h${level}[^>]*>([\\s\\S]*?)</h${level}>`, 'g')
  return [...html.matchAll(re)].map((m) => ({ text: textOf(m[1]!), at: m.index }))
}

/** The HTML from the one heading with these words to the next heading of the same level. */
function section(html: string, level: number, text: string): string {
  const all = headings(html, level)
  const hits = all.flatMap((h, i) => (words(h.text) === words(text) ? [i] : []))
  if (hits.length !== 1) {
    throw new Error(`alibaba-pricing: ${hits.length} <h${level}> headings read "${text}"`)
  }
  const i = hits[0]!
  return html.slice(all[i]!.at, all[i + 1]?.at ?? html.length)
}

/** Rows of a <thead> or <tbody> laid out on a grid: a rowspan or colspan cell fills every slot it covers. */
export function grid(fragment: string): Cell[][] {
  const out: Cell[][] = []
  const rows = [...fragment.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]!)
  rows.forEach((tr, r) => {
    out[r] ??= []
    let c = 0
    for (const m of tr.matchAll(/<t([dh])([^>]*)>([\s\S]*?)<\/t\1>/g)) {
      while (out[r]![c]) c++
      const rowspan = Number(m[2]!.match(/rowspan="(\d+)"/)?.[1] ?? 1)
      const colspan = Number(m[2]!.match(/colspan="(\d+)"/)?.[1] ?? 1)
      const cell = { html: m[3]!, text: textOf(m[3]!) }
      for (let dr = 0; dr < rowspan; dr++) {
        out[r + dr] ??= []
        for (let dc = 0; dc < colspan; dc++) out[r + dr]![c + dc] = cell
      }
      c += colspan
    }
  })
  return out
}

/** Each column's label: its header cells' text top to bottom, a repeat (a rowspan) said once. */
export function columnLabels(head: Cell[][]): string[] {
  const width = Math.max(...head.map((r) => r.length))
  return Array.from({ length: width }, (_, c) => {
    const parts: string[] = []
    for (const row of head) {
      const t = row[c]?.text
      if (t && parts.at(-1) !== t) parts.push(t)
    }
    return parts.join(' / ')
  })
}

/** The header and body rows of a table: its <thead>, or else its first row. */
function split(table: string): { head: Cell[][]; body: Cell[][] } {
  const thead = table.match(/<thead[^>]*>([\s\S]*?)<\/thead>/)?.[1]
  const tbody = table.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/)?.[1] ?? ''
  if (thead !== undefined) return { head: grid(thead), body: grid(tbody) }
  const [first, ...rest] = grid(tbody)
  return { head: first ? [first] : [], body: rest }
}

function column(labels: string[], name: string, test: (w: string) => boolean): number {
  const hits = labels.flatMap((l, i) => (test(words(l)) ? [i] : []))
  if (hits.length !== 1) throw new Error(`alibaba-pricing: expected one ${name} column`)
  return hits[0]!
}

/** "$2" | "Original$0.4 (20% off for a limited time)" -> the printed price; "" -> null. */
function price(text: string): { usd: number | null; promo: string | null } {
  if (text === '') return { usd: null, promo: null }
  const m = text.match(PRICE)
  if (!m) throw new Error(`alibaba-pricing: cell does not print a USD price: ${text}`)
  return { usd: Number(m[1]), promo: m[2]?.trim() ?? null }
}

/** null for the first band (or an untiered model); otherwise `input_<from>_<to>`. */
export function bandTier(text: string): string | null {
  if (NO_TIERS.test(text)) return null
  const m = text.match(BAND)
  if (!m) throw new Error(`alibaba-pricing: unrecognized input band: ${text}`)
  return m[1] === '0' ? null : `input_${m[1]!.toLowerCase()}_${m[2]!.toLowerCase()}`
}

const isBand = (text: string) => BAND.test(text) || NO_TIERS.test(text)

function slugOf(modelHtml: string): string {
  return textOf(modelHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '')
}

interface Columns {
  model: number
  scope: number
  pattern: number | null
  band: number
  input: number
  output: number
  thinking: number | null
}

/** The columns with one removed and every later one a place nearer: the layout of a row that omits that cell. */
function without(col: Columns, gone: number): Columns {
  const at = (i: number) => (i > gone ? i - 1 : i)
  return {
    model: at(col.model),
    scope: at(col.scope),
    pattern: null,
    band: at(col.band),
    input: at(col.input),
    output: at(col.output),
    thinking: col.thinking === null ? null : at(col.thinking),
  }
}

/**
 * The columns this row's cells are read under, or null when none is provable.
 * The header's own win when the row's model cell holds an id and its band cell
 * a band (and its Pattern cell is not also a band, which would be a second
 * reading). Otherwise, for a table with a Pattern column, the header without
 * it wins when the row fits that the same way and every cell past its last
 * price is empty or the free-quota phrase.
 */
function columnsFor(cells: Cell[], col: Columns): Columns | null {
  const fits = (c: Columns) =>
    SLUG.test(slugOf(cells[c.model]?.html ?? '')) && isBand(cells[c.band]?.text ?? '')
  if (fits(col)) return col.pattern !== null && isBand(cells[col.pattern]?.text ?? '') ? null : col
  if (col.pattern === null || col.thinking !== null) return null
  const short = without(col, col.pattern)
  if (!fits(short)) return null
  const last = Math.max(short.model, short.scope, short.band, short.input, short.output)
  return cells.slice(last + 1).every((c) => c.text === '' || QUOTA.test(c.text)) ? short : null
}

function tableRows(table: string, line: string, prov: Provenance): PriceRow[] {
  const { head, body } = split(table)
  if (head.length === 0 || body.length === 0)
    throw new Error(`alibaba-pricing: ${line}: empty table`)
  const labels = columnLabels(head)
  const outputs = labels.flatMap((l, i) => (/^output (unit )?price\b/.test(words(l)) ? [i] : []))
  if (outputs.length === 0 || outputs.length > 2) {
    throw new Error(`alibaba-pricing: ${line}: ${outputs.length} output price columns`)
  }
  const output =
    outputs.length === 1
      ? outputs[0]!
      : outputs.find((i) => words(labels[i]!).includes('non thinking'))
  const thinking = outputs.length === 2 ? outputs.find((i) => i !== output) : undefined
  if (output === undefined || (outputs.length === 2 && thinking === undefined)) {
    throw new Error(`alibaba-pricing: ${line}: cannot tell the non-thinking output column`)
  }
  const patterns = labels.flatMap((l, i) => (words(l) === 'pattern' ? [i] : []))
  const header: Columns = {
    model: column(labels, 'Model ID', (w) => w.startsWith('model id')),
    scope: column(labels, 'deployment scope', (w) => w.includes('deployment scope')),
    pattern: patterns.length === 1 ? patterns[0]! : null,
    band: column(
      labels,
      'input token range',
      (w) => w.startsWith('input token') && w.includes('per request'),
    ),
    input: column(labels, 'input price', (w) => /^input (unit )?price\b/.test(w)),
    output,
    thinking: thinking ?? null,
  }

  const rows: PriceRow[] = []
  for (const cells of body) {
    const col = columnsFor(cells, header)
    if (col === null) {
      // Without a layout the scope column is unknown too, so any cell naming
      // the scope makes the row one this parser owes a price for.
      if (!cells.some((c) => words(c.text) === words(SCOPE))) continue
      const printed = cells.map((c) => c.text).join(' | ')
      throw new Error(
        `alibaba-pricing: ${line}: a row's cells fit no column layout: ${printed.slice(0, 160)}`,
      )
    }
    if (words(cells[col.scope]?.text ?? '') !== words(SCOPE)) continue
    const slug = slugOf(cells[col.model]!.html)
    const annotation = cells[col.model]!.text.slice(slug.length).trim()
    const band = cells[col.band]!.text
    const input = price(cells[col.input]?.text ?? '')
    const out = price(cells[col.output]?.text ?? '')
    const think = col.thinking === null ? null : price(cells[col.thinking]?.text ?? '')
    // Notes keep their old wording so a re-translation does not rewrite every stored note.
    const alias = annotation.match(
      /(?:currently|current capabilities are) equivalent to (\S+)/i,
    )?.[1]
    const off = (input.promo ?? out.promo)?.match(/(\d+)% off/)?.[1]
    const promo = off ? `Limited-time ${off}% off` : null
    const notes = [
      `${line}, ${REGION} (${SCOPE})`,
      `input tokens per request ${band}`,
      alias ? `Currently equivalent to ${alias}` : null,
      think && think.usd !== null ? `thinking-mode output $${think.usd}` : null,
      promo ? `list price shown; ${promo} at the read` : null,
    ].filter((n): n is string => n !== null)
    rows.push({
      provider: 'alibaba',
      model_slug: slug,
      tier: bandTier(band),
      context_window: null, // the page prints request bands, not a context window
      input_per_mtok: input.usd,
      cached_input_per_mtok: null,
      output_per_mtok: out.usd,
      currency: 'USD',
      effective_from: null,
      effective_until: null,
      notes: notes.join('; '),
      ...prov,
    })
  }
  return rows
}

interface CachePrice {
  slug: string
  write5m: number
  write1h: number
  read: number
}

const CACHE_LABELS = [
  (w: string) => /^cache (write|creation) 5m$/.test(w),
  (w: string) => /^cache (write|creation) 1h$/.test(w),
  (w: string) => /^(explicit implicit )?cache (read|hit)$/.test(w),
]
const CACHE_CAPTION =
  /^([a-z0-9][a-z0-9.-]*) [—–-] cache (?:unit )?prices? \(per million tokens\)$/i

/**
 * A model's cache price table, or null for any other table. `before` is the
 * HTML between the previous table and this one, whose last paragraph is the
 * caption naming the model ("qwen4-max — Cache unit prices (per million tokens)").
 * A table with these headers but no such caption, or not exactly one row of
 * three plain USD prices, fails the parse: a cache price that cannot be tied
 * to one model is not stored under a guessed one.
 */
function cacheTable(table: string, before: string, line: string): CachePrice | null {
  const { head, body } = split(table)
  const labels = head.length ? columnLabels(head) : []
  if (labels.length !== CACHE_LABELS.length) return null
  if (!CACHE_LABELS.every((test, i) => test(words(labels[i]!)))) return null
  const captions = [...before.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
  const slug = textOf(captions.at(-1)?.[1] ?? '').match(CACHE_CAPTION)?.[1]
  if (!slug) throw new Error(`alibaba-pricing: ${line}: a cache price table names no model`)
  if (body.length !== 1 || body[0]!.length !== 3) {
    throw new Error(`alibaba-pricing: ${line}: ${slug}'s cache price table is not one row of three`)
  }
  const [write5m, write1h, read] = body[0]!.map((c) => {
    const p = price(c.text)
    if (p.usd === null || p.promo !== null) {
      throw new Error(
        `alibaba-pricing: ${line}: ${slug} cache cell does not print a USD price: ${c.text}`,
      )
    }
    return p.usd
  })
  return { slug, write5m: write5m!, write1h: write1h!, read: read! }
}

// One-argument calls read the fixture's provenance, keeping the determinism gate byte-identical.
export function parseAlibabaPricingHtml(
  html: string,
  prov: Provenance = fixtureProvenance('alibaba-pricing-html'),
) {
  const qwen = section(html, 2, SECTION)
  const rows: PriceRow[] = []
  for (const line of LINES) {
    const tab = section(section(qwen, 3, line), 4, REGION)
    const tables = [...tab.matchAll(/<table[\s\S]*?<\/table>/g)]
    if (tables.length === 0) throw new Error(`alibaba-pricing: ${line}: no ${REGION} table`)
    const found: PriceRow[] = []
    const caches: CachePrice[] = []
    tables.forEach((m, i) => {
      const before = tab.slice(
        i === 0 ? 0 : tables[i - 1]!.index + tables[i - 1]![0].length,
        m.index,
      )
      const cache = cacheTable(m[0], before, line)
      if (cache) caches.push(cache)
      else found.push(...tableRows(m[0], line, prov))
    })
    if (found.length === 0) throw new Error(`alibaba-pricing: ${line}: no ${SCOPE} row`)
    for (const cache of caches) {
      const priced = found.filter((r) => r.model_slug === cache.slug)
      if (priced.length === 0) {
        throw new Error(
          `alibaba-pricing: ${line}: a cache price for ${cache.slug}, which has no ${SCOPE} row`,
        )
      }
      for (const r of priced) {
        if (r.cached_input_per_mtok !== null)
          throw new Error(`alibaba-pricing: ${line}: ${cache.slug} has two cache prices`)
        r.cached_input_per_mtok = cache.read
        r.notes = [
          r.notes,
          `5m cache writes $${cache.write5m}`,
          `1h cache writes $${cache.write1h}`,
        ].join('; ')
      }
    }
    rows.push(...found)
  }

  const keys = new Set<string>()
  for (const r of rows) {
    const key = `${r.model_slug}:${r.tier ?? ''}`
    if (keys.has(key)) throw new Error(`alibaba-pricing: ${key} is priced twice`)
    keys.add(key)
  }
  rows.sort((a, b) => {
    const ka = `${a.model_slug}\u0000${a.tier ?? ''}`
    const kb = `${b.model_slug}\u0000${b.tier ?? ''}`
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
  return VendorMdPricingOutput.parse({ rows })
}

registerParser({
  name: 'alibaba-pricing-html',
  lane: 'vendor-md',
  fixturePath: 'fixtures/pricing/alibaba-pricing.html',
  sideFixturePaths: [],
  schema: VendorMdPricingOutput,
  parse: (text) => parseAlibabaPricingHtml(text),
})
