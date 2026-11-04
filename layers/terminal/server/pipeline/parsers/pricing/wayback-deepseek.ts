import { VendorMdPricingOutput, modelKey, type PriceRow, type Provenance } from '../../contracts'
import { htmlGridTables, htmlText, stripInvisible } from './html-table'

// DeepSeek's own pricing page as the Internet Archive captured it
// (archive/eras.ts names each era's URL and window): platform.deepseek.com/
// api-docs/pricing until November 2024, then api-docs.deepseek.com/
// quick_start/pricing, whose markdown twin the live parser reads. Server-
// rendered HTML throughout, in four table layouts:
//
//   2024: one row per model (MODEL | … | INPUT PRICE | OUTPUT PRICE), with
//   cache-hit and cache-miss input columns from August 2024; a USD table
//   and the same table in CNY.
//   2025: one column per model ("transposed"), a STANDARD PRICE band and a
//   DISCOUNT PRICE band for set UTC hours.
//   late 2025 to mid-2026: transposed, one price per row, often one cell
//   spanning every model column.
//   from mid-2026: transposed, a PEAK and an OFF-PEAK band, the live layout.
//
// Prices are read as printed in USD; a CNY table is never read and a CNY
// cell where USD is expected throws. As live (deepseek-pricing.ts), the
// cache-miss input is the input price, the cache-hit input is the cached-
// input price, and the list price is the untiered row. The band the page
// called DISCOUNT PRICE in 2025 (UTC 16:30-00:30, 50% or 75% off) and
// OFF-PEAK from 2026 is in both cases a lower price for set hours of the day,
// which the live parser files as tier `off_peak`; both are filed there, and
// each row keeps the band's printed label and hours in notes.

const MODEL = /^deepseek-[a-z0-9][a-z0-9.-]*$/

function base(slug: string, prov: Provenance): PriceRow {
  return {
    provider: 'deepseek',
    model_slug: slug,
    tier: null,
    context_window: null,
    input_per_mtok: null,
    cached_input_per_mtok: null,
    output_per_mtok: null,
    currency: 'USD',
    effective_from: null,
    effective_until: null,
    notes: null,
    ...prov,
  }
}

const keyOf = (r: PriceRow) => modelKey(r.provider, r.model_slug, r.tier)

const AMOUNT = String.raw`\$(\d+(?:\.\d+)?)(?: ?\/ ?1M ?tokens)?`
const ONE = new RegExp(String.raw`^${AMOUNT}\s*(?:[（(]([^）)]*)[）)])?$`)
// "$0.07/ 1M tokens (4) $0.014 / 1M tokens", footnote (4): "The form shows the
// the original price and the discounted price" (December 2024 to February 2025).
const ORIGINAL_THEN_DISCOUNT = new RegExp(String.raw`^${AMOUNT} \(\d\) ${AMOUNT}$`)
// "$0.003625 (75% off (3) ) $0.0145": the discounted price, then the original (2026).
const DISCOUNT_THEN_ORIGINAL = new RegExp(
  String.raw`^${AMOUNT} \((\d+% off)(?: \(\d\))? ?\) ${AMOUNT}$`,
)
const ORIGINAL_FIRST_NOTE = /shows the (?:the )?original price and the discounted price/

/**
 * "$0.14 / 1M tokens" | "$0.035（50% OFF）" | "$0.07" -> the amount. A cell that
 * prints an original and a discounted price stores the original (the list
 * price, as the live Alibaba parser does with "List price") and notes the
 * discount in force at the capture. Which amount is the original is read
 * from the page: its footnote for the 2024 layout, the "% off" mark in 2026.
 */
function usd(
  cell: string,
  where: string,
  originalFirst: boolean,
): { price: number; extra: string | null } {
  const one = cell.match(ONE)
  // "$2.19 (6)": a footnote marker, not an annotation.
  if (one) return { price: Number(one[1]), extra: one[2] && !/^\d$/.test(one[2]) ? one[2] : null }
  const a = cell.match(ORIGINAL_THEN_DISCOUNT)
  if (a && originalFirst)
    return { price: Number(a[1]), extra: `discounted to $${a[2]} at the capture` }
  const b = cell.match(DISCOUNT_THEN_ORIGINAL)
  if (b) return { price: Number(b[3]), extra: `discounted to $${b[1]} (${b[2]}) at the capture` }
  throw new Error(`${where}: cell does not print a USD price: ${cell}`)
}

/** "deepseek-chat *" | "deepseek-chat(1)" -> "deepseek-chat". */
const modelName = (cell: string) =>
  cell
    .replace(/\s*\*$/, '')
    .replace(/\s*\(\d+\)$/, '')
    .trim()

type Field = 'cached_input_per_mtok' | 'input_per_mtok' | 'output_per_mtok'

/** Which price a row or column label names. */
function fieldOf(label: string): Field | null {
  if (/CACHE HIT/.test(label)) return 'cached_input_per_mtok'
  if (/CACHE MISS/.test(label)) return 'input_per_mtok'
  if (/OUTPUT/.test(label) && /PRICE|TOKENS/.test(label)) return 'output_per_mtok'
  if (/INPUT PRICE|INPUT TOKENS/.test(label)) return 'input_per_mtok'
  return null
}

/** The time band a transposed price row belongs to, and the tier it is filed under. */
function bandOf(label: string): { tier: string | null; note: string | null } {
  if (/OFF-PEAK/.test(label)) return { tier: 'off_peak', note: 'off-peak hours' }
  if (/DISCOUNT PRICE/.test(label)) {
    const hours = label.match(/UTC [\d:]+-[\d:]+/)?.[0]
    return { tier: 'off_peak', note: `printed as "DISCOUNT PRICE"${hours ? ` (${hours})` : ''}` }
  }
  if (/\bPEAK\b/.test(label)) return { tier: null, note: 'peak hours (the list price)' }
  if (/STANDARD PRICE/.test(label)) {
    const hours = label.match(/UTC [\d:]+-[\d:]+/)?.[0]
    return { tier: null, note: `printed as "STANDARD PRICE"${hours ? ` (${hours})` : ''}` }
  }
  return { tier: null, note: null }
}

/** One row per model, columns named in the header: the 2024 layout. */
function rowPerModel(table: string[][], prov: Provenance, originalFirst: boolean): PriceRow[] {
  const [header, ...body] = table
  // Only price columns: "MAX OUTPUT TOKENS" names output but prints a length.
  const cols = header!.map((h) => (/PRICE/.test(h) ? fieldOf(h) : null))
  if (!cols.includes('input_per_mtok') || !cols.includes('output_per_mtok')) {
    throw new Error(`price table: columns changed: ${header!.join(' | ')}`)
  }
  return body.map((cells) => {
    const slug = modelName(cells[0] ?? '')
    if (!MODEL.test(slug)) throw new Error(`unrecognised model: ${cells[0]}`)
    const notes: string[] = cells[0] !== slug ? [`printed as "${cells[0]}"`] : []
    const row: PriceRow = { ...base(slug, prov) }
    cols.forEach((f, i) => {
      if (!f) return
      const { price, extra } = usd(cells[i] ?? '', slug, originalFirst)
      row[f] = price
      if (extra) notes.push(noteFor(f, extra))
    })
    return { ...row, notes: notes.join('; ') || null }
  })
}

/** One column per model, labels in the leading columns: the 2025 and 2026 layouts. */
function columnPerModel(table: string[][], prov: Provenance, originalFirst: boolean): PriceRow[] {
  const head = table[0]!
  const first = head.findIndex((c) => MODEL.test(modelName(c)))
  const models = head.slice(first).map(modelName)
  if (models.some((m) => !MODEL.test(m)))
    throw new Error(`unrecognised model column: ${head.join(' | ')}`)
  const label = (cells: string[]) =>
    [...new Set(cells.slice(0, first).filter((c) => c !== ''))].join(' / ')
  const version = table.find((r) => /^MODEL VERSION/.test(r[0] ?? ''))
  const rows = new Map<string, PriceRow>()
  for (const cells of table.slice(1)) {
    const name = label(cells)
    const field = /PRICE|PRICING/.test(name) ? fieldOf(name) : null
    if (!field) continue
    const band = bandOf(name)
    models.forEach((slug, i) => {
      const cell = cells[first + i] ?? ''
      const { price, extra } = usd(cell, `${slug} ${name}`, originalFirst)
      // Keyed by column: December 2025 printed deepseek-reasoner twice (the
      // V3.2-Speciale column ran on another base URL). Columns of one model
      // must agree and are merged below.
      const key = `${i}:${band.tier ?? ''}`
      const row =
        rows.get(key) ??
        ({
          ...base(slug, prov),
          tier: band.tier,
          notes: [version?.[first + i], band.note].filter(Boolean).join('; ') || null,
        } satisfies PriceRow)
      if (row[field] !== null) throw new Error(`${slug}: two ${field} prices in one band`)
      row[field] = price
      if (extra) row.notes = [row.notes, noteFor(field, extra)].filter(Boolean).join('; ')
      rows.set(key, row)
    })
  }
  const merged = new Map<string, PriceRow>()
  for (const r of rows.values()) {
    const held = merged.get(keyOf(r))
    if (!held) merged.set(keyOf(r), r)
    else if (FIELDS.some((f) => held[f] !== r[f])) {
      throw new Error(`${r.model_slug}: two columns at different prices`)
    }
  }
  return [...merged.values()]
}

const FIELDS: readonly Field[] = ['input_per_mtok', 'cached_input_per_mtok', 'output_per_mtok']

const noteFor = (field: Field, extra: string) =>
  extra.startsWith('discounted')
    ? `${field.replace('_per_mtok', '')} ${extra}`
    : `${field.replace('_per_mtok', '')} printed with "${extra}"`

/**
 * The page's price table, in whichever layout the capture has. The table
 * whose header row is MODEL … and whose cells print dollars is the one read;
 * a table in CNY is passed over. Every model needs an input and an output
 * price in every band, or the capture is skipped.
 */
export function parseDeepseekPricingHtml(html: string, prov: Provenance) {
  const originalFirst = ORIGINAL_FIRST_NOTE.test(htmlText(stripInvisible(html)))
  const rows: PriceRow[] = []
  let read = 0
  for (const table of htmlGridTables(html)) {
    const head = table[0] ?? []
    if (!/^MODEL\b/.test(head[0] ?? '')) continue
    const cells = table.slice(1).flat()
    const yuan = cells.some((c) => /¥|￥|CNY/.test(c))
    const dollars = cells.some((c) => /\$\d/.test(c))
    if (yuan && !dollars) continue
    if (yuan) throw new Error('a table prints USD and CNY together')
    if (!dollars) continue
    read++
    const transposed = head.slice(1).some((c) => MODEL.test(modelName(c)))
    rows.push(
      ...(transposed
        ? columnPerModel(table, prov, originalFirst)
        : rowPerModel(table, prov, originalFirst)),
    )
  }
  if (read === 0) throw new Error('no USD price table under a MODEL header')
  const byKey = new Map<string, PriceRow>()
  for (const r of rows) {
    if (r.input_per_mtok === null || r.output_per_mtok === null) {
      throw new Error(`${keyOf(r)}: no input or no output price`)
    }
    if (byKey.has(keyOf(r))) throw new Error(`${keyOf(r)} priced twice`)
    byKey.set(keyOf(r), r)
  }
  return VendorMdPricingOutput.parse({
    rows: [...byKey.values()].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1)),
  })
}
