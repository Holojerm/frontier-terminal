import { VendorMdPricingOutput, type PriceRow, type Provenance } from '../../contracts'
import { textOf } from '../disclosures/html-text'
import { bandTier, columnLabels, grid, type Cell } from './alibaba-pricing'
import { htmlText } from './html-table'

// Alibaba Cloud's Model Studio pricing page (www.alibabacloud.com/help/en/
// model-studio/model-pricing) as the Internet Archive captured it, January
// to August 2026. Same lines and same rules as the live parser
// (alibaba-pricing.ts): Qwen-Max, Qwen-Plus and Qwen-Flash, the
// international list price in USD per million tokens, the first input band
// as the untiered row and each later band as `input_<from>_<to>`, the
// non-thinking output as the output price, a "List price $X" cell read as X.
//
// Where the international price sat:
//   until mid-2026, a region tab named "International" under each line (beside
//   "Global", "US", "Mainland China"…), its tables with no Deployment scope
//   column;
//   from mid-2026, a "Singapore" tab whose rows carry a Deployment scope
//   column, the rows scoped "International" being the ones read — the
//   layout the live parser reads.
// The earlier "International" tab is the same deployment scope the live
// parser reads under Singapore (Alibaba runs its international deployment
// from Singapore), so its rows land on the same keys, and each says which
// tab it was printed under.

const SECTION = 'Text generation - Qwen'
const LINES = ['Qwen-Max', 'Qwen-Plus', 'Qwen-Flash'] as const
const SLUG = /^[a-z0-9][a-z0-9.-]*$/
const PRICE = /^(?:List price )?\$(\d+(?:\.\d+)?)(?: \(?(Limited-time \d+% off)\)?)?$/

interface Heading {
  level: number
  text: string
  at: number
}

function headings(html: string): Heading[] {
  return [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => ({
    level: Number(m[1]),
    text: textOf(m[2]!),
    at: m.index,
  }))
}

/** The HTML from heading `h` to the next heading of a level in `stops`. */
function slice(html: string, all: Heading[], h: Heading, stops: number[]): string {
  const next = all.find((x) => x.at > h.at && stops.includes(x.level))
  return html.slice(h.at, next?.at ?? html.length)
}

function price(text: string, where: string): { usd: number | null; promo: string | null } {
  // "-": a mode the model does not have (thinking output on a non-thinking snapshot).
  if (text === '' || text === '-') return { usd: null, promo: null }
  const m = text.match(PRICE)
  if (!m) throw new Error(`${where}: cell does not print a USD price: ${text}`)
  return { usd: Number(m[1]), promo: m[2] ?? null }
}

/** A table's header rows are the ones before its first model row. */
function split(rows: Cell[][]): { head: Cell[][]; body: Cell[][] } {
  const first = rows.findIndex((r) => SLUG.test(slugOf(r[0]) ?? ''))
  if (first < 1) throw new Error('a table with no header or no model row')
  return { head: rows.slice(0, first), body: rows.slice(first) }
}

/** The model id: the cell's first paragraph, or its first word ("qwen3-max Batch calling …"). */
function slugOf(cell: Cell | undefined): string | null {
  if (!cell) return null
  const p = cell.html.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1]
  const first = (p ? textOf(p) : cell.text).split(' ')[0] ?? ''
  return SLUG.test(first) ? first : null
}

function tableRows(table: string, line: string, tab: string, scoped: boolean, prov: Provenance) {
  const { head, body } = split(grid(table))
  const labels = columnLabels(head)
  const find = (re: RegExp) => {
    const hits = labels.flatMap((l, i) => (re.test(l) ? [i] : []))
    if (hits.length !== 1)
      throw new Error(`${line}: expected one column ${re}, found ${hits.length}`)
    return hits[0]!
  }
  const col = {
    model: find(/^Model( ID)?$/),
    band: find(/^Input tokens per request/),
    input: find(/^Input price/),
    scope: scoped ? find(/^Deployment scope/) : -1,
  }
  const outputs = labels.flatMap((l, i) => (/^Output price/.test(l) ? [i] : []))
  if (outputs.length === 0 || outputs.length > 2) {
    throw new Error(`${line}: ${outputs.length} output price columns`)
  }
  const output =
    outputs.length === 1 ? outputs[0]! : outputs.find((i) => /Non-thinking/i.test(labels[i]!))
  const thinking = outputs.find((i) => i !== output)
  if (output === undefined) throw new Error(`${line}: cannot tell the non-thinking output column`)

  const rows: PriceRow[] = []
  for (const cells of body) {
    if (scoped && cells[col.scope]?.text !== 'International') continue
    const slug = slugOf(cells[col.model])
    if (!slug) throw new Error(`${line}: unrecognised model cell: ${cells[col.model]?.text}`)
    const where = `${line} ${slug}`
    const band = cells[col.band]?.text ?? ''
    const input = price(cells[col.input]?.text ?? '', where)
    const out = price(cells[output]?.text ?? '', where)
    const think = thinking === undefined ? null : price(cells[thinking]?.text ?? '', where)
    const promo = input.promo ?? out.promo
    rows.push({
      provider: 'alibaba',
      model_slug: slug,
      tier: bandTier(band),
      context_window: null,
      input_per_mtok: input.usd,
      cached_input_per_mtok: null,
      output_per_mtok: out.usd,
      currency: 'USD',
      effective_from: null,
      effective_until: null,
      notes: [
        `${line}, ${tab}`,
        `input tokens per request ${band}`,
        // Spaced text: the plain cell text runs the alias into the next badge.
        htmlText(cells[col.model]!.html).match(
          /Currently equivalent to [a-z0-9][a-z0-9.-]*/,
        )?.[0] ?? null,
        think && think.usd !== null ? `thinking-mode output $${think.usd}` : null,
        promo ? `list price shown; ${promo} at the read` : null,
      ]
        .filter((n): n is string => n !== null)
        .join('; '),
      ...prov,
    })
  }
  return rows
}

/**
 * The three Qwen lines' international prices, in whichever tab layout the
 * capture has. A line without that tab, or with a table this reader cannot
 * lay out, skips the capture: one line missing would read as a delisting.
 */
export function parseAlibabaPricingHtmlArchived(html: string, prov: Provenance) {
  const all = headings(html)
  const qwen = all.find((h) => h.level === 2 && h.text === SECTION)
  if (!qwen) throw new Error(`no <h2> "${SECTION}"`)
  const rows: PriceRow[] = []
  for (const line of LINES) {
    const lineHead = all.find((h) => h.at > qwen.at && h.level === 3 && h.text === line)
    if (!lineHead) throw new Error(`no <h3> "${line}"`)
    const next = all.find((h) => h.at > lineHead.at && (h.level === 3 || h.level === 1))
    const inLine = all.filter((h) => h.at > lineHead.at && (!next || h.at < next.at))
    const singapore = inLine.find((h) => h.level === 4 && h.text === 'Singapore')
    const international = inLine.find((h) => h.level === 2 && h.text === 'International')
    const tab = singapore ?? international
    if (!tab) throw new Error(`${line}: no Singapore or International tab`)
    const region = slice(html, all, tab, singapore ? [1, 2, 3, 4] : [1, 2, 3])
    const tables = [...region.matchAll(/<table[\s\S]*?<\/table>/g)].map((m) => m[0])
    if (tables.length === 0) throw new Error(`${line}: no table under ${tab.text}`)
    const label = singapore ? 'Singapore (International)' : 'International tab'
    const found = tables.flatMap((t) => tableRows(t, line, label, Boolean(singapore), prov))
    if (found.length === 0) throw new Error(`${line}: no international row`)
    rows.push(...found)
  }
  const keys = new Set<string>()
  for (const r of rows) {
    const key = `${r.model_slug}:${r.tier ?? ''}`
    if (keys.has(key)) throw new Error(`${key} is priced twice`)
    keys.add(key)
  }
  rows.sort((a, b) => {
    const ka = `${a.model_slug}\u0000${a.tier ?? ''}`
    const kb = `${b.model_slug}\u0000${b.tier ?? ''}`
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
  return VendorMdPricingOutput.parse({ rows })
}
