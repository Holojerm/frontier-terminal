import {
  registerParser,
  VendorMdPricingOutput,
  type PriceRow,
  type Provenance,
} from '../../contracts'
import { textOf } from '../disclosures/html-text'
import { fixtureProvenance } from '../fixture-provenance'

// alibaba-pricing-html — www.alibabacloud.com/help/en/model-studio/model-pricing
// Alibaba Cloud's international site. Server-rendered HTML, one <h3> per model
// line and one <h4> tab per region under it, each a table priced in USD per
// million tokens. Read, and nothing else:
//
//   - the "Text generation - Qwen" section, lines Qwen-Max, Qwen-Plus and
//     Qwen-Flash: the commercial text lines the class map draws from. The
//     specialised lines (Omni, VL, OCR, Coder, Translation, …), the
//     open-weight section and the "third-party models" section (DeepSeek,
//     Kimi, GLM, MiniMax, which Alibaba resells) are not Alibaba's
//     list price for a Qwen text model and are not parsed;
//   - the Singapore tab and its "International" deployment rows: the
//     international list price. Beijing, Hong Kong, Frankfurt, Virginia and
//     Tokyo print other prices for the same ids and are not read.
//
// A model is tiered by input tokens per request ("0<Token≤256K",
// "256K<Token≤1M"). The first band is the standard row; each later band is
// its own tier (`input_256k_1m`), as OpenAI's long-context rows are. Where a
// table prices non-thinking and thinking output apart, the non-thinking price
// is the output price and the thinking one is kept in notes. A "List price $X
// (Limited-time N% off)" cell stores the list price X and notes the promotion:
// the page states no end date, so no effective_until is set. The page's
// cache and batch discounts are percentages on other pages and are not read.

const SECTION = 'Text generation - Qwen'
const LINES = ['Qwen-Max', 'Qwen-Plus', 'Qwen-Flash'] as const
const REGION = 'Singapore'
const SCOPE = 'International'

const SLUG = /^[a-z0-9][a-z0-9.-]*$/
const BAND = /^(\d+[KM]?)<Token≤(\d+[KM])$/
const PRICE = /^(?:List price )?\$(\d+(?:\.\d+)?)(?: \((Limited-time \d+% off)\))?$/

interface Cell {
  html: string
  text: string
}

/** Every heading of one level with its text and where it starts. */
function headings(html: string, level: number): { text: string; at: number }[] {
  const re = new RegExp(`<h${level}[^>]*>([\\s\\S]*?)</h${level}>`, 'g')
  return [...html.matchAll(re)].map((m) => ({ text: textOf(m[1]!), at: m.index }))
}

/** The HTML from the heading with this text to the next heading of the same level. */
function section(html: string, level: number, text: string): string {
  const all = headings(html, level)
  const i = all.findIndex((h) => h.text === text)
  if (i === -1) throw new Error(`alibaba-pricing: no <h${level}> "${text}"`)
  return html.slice(all[i]!.at, all[i + 1]?.at ?? html.length)
}

/** Rows of a <thead> or <tbody> laid out on a grid: a rowspan or colspan cell fills every slot it covers. */
function grid(fragment: string): Cell[][] {
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
function columnLabels(head: Cell[][]): string[] {
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

function column(labels: string[], prefix: string): number {
  const hits = labels.flatMap((l, i) => (l.startsWith(prefix) ? [i] : []))
  if (hits.length !== 1) throw new Error(`alibaba-pricing: expected one "${prefix}" column`)
  return hits[0]!
}

/** "$2" | "List price $0.4 (Limited-time 20% off)" -> the printed list price; "" -> null. */
function price(text: string): { usd: number | null; promo: string | null } {
  if (text === '') return { usd: null, promo: null }
  const m = text.match(PRICE)
  if (!m) throw new Error(`alibaba-pricing: cell does not print a USD price: ${text}`)
  return { usd: Number(m[1]), promo: m[2] ?? null }
}

/** null for the first band (or an untiered model); otherwise `input_<from>_<to>`. */
function bandTier(text: string): string | null {
  if (text === 'No tiered pricing') return null
  const m = text.match(BAND)
  if (!m) throw new Error(`alibaba-pricing: unrecognized input band: ${text}`)
  return m[1] === '0' ? null : `input_${m[1]!.toLowerCase()}_${m[2]!.toLowerCase()}`
}

function tableRows(table: string, line: string, prov: Provenance): PriceRow[] {
  const head = grid(table.match(/<thead[^>]*>([\s\S]*?)<\/thead>/)?.[1] ?? '')
  const body = grid(table.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/)?.[1] ?? '')
  if (head.length === 0 || body.length === 0)
    throw new Error(`alibaba-pricing: ${line}: empty table`)
  const labels = columnLabels(head)
  const col = {
    model: column(labels, 'Model ID'),
    scope: column(labels, 'Deployment scope'),
    band: column(labels, 'Input tokens per request'),
    input: column(labels, 'Input price (per 1 million tokens)'),
  }
  const outputs = labels.flatMap((l, i) =>
    l.startsWith('Output price (per 1 million tokens)') ? [i] : [],
  )
  if (outputs.length === 0 || outputs.length > 2) {
    throw new Error(`alibaba-pricing: ${line}: ${outputs.length} output price columns`)
  }
  const output =
    outputs.length === 1 ? outputs[0]! : outputs.find((i) => labels[i]!.includes('Non-Thinking'))
  const thinking = outputs.length === 2 ? outputs.find((i) => i !== output) : undefined
  if (output === undefined || (outputs.length === 2 && thinking === undefined)) {
    throw new Error(`alibaba-pricing: ${line}: cannot tell the non-thinking output column`)
  }

  const rows: PriceRow[] = []
  for (const cells of body) {
    if (cells[col.scope]?.text !== SCOPE) continue
    const modelHtml = cells[col.model]?.html ?? ''
    const slug = textOf(modelHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '')
    if (!SLUG.test(slug))
      throw new Error(`alibaba-pricing: ${line}: unrecognized model id: ${slug}`)
    const annotation = cells[col.model]!.text.slice(slug.length).trim()
    const band = cells[col.band]?.text ?? ''
    const input = price(cells[col.input]?.text ?? '')
    const out = price(cells[output]?.text ?? '')
    const think = thinking === undefined ? null : price(cells[thinking]?.text ?? '')
    const promo = input.promo ?? out.promo
    const notes = [
      `${line}, ${REGION} (${SCOPE})`,
      `input tokens per request ${band}`,
      annotation.match(/Currently equivalent to \S+/)?.[0] ?? null,
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

// prov defaults to the fixture manifest's record (single-arg behavior is
// byte-identical for the determinism gate); the refresh orchestrator passes
// the live fetch's provenance instead.
export function parseAlibabaPricingHtml(
  html: string,
  prov: Provenance = fixtureProvenance('alibaba-pricing-html'),
) {
  const qwen = section(html, 2, SECTION)
  const rows: PriceRow[] = []
  for (const line of LINES) {
    const tab = section(section(qwen, 3, line), 4, REGION)
    const tables = [...tab.matchAll(/<table[\s\S]*?<\/table>/g)].map((m) => m[0])
    if (tables.length === 0) throw new Error(`alibaba-pricing: ${line}: no ${REGION} table`)
    const found = tables.flatMap((t) => tableRows(t, line, prov))
    if (found.length === 0) throw new Error(`alibaba-pricing: ${line}: no ${SCOPE} row`)
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
