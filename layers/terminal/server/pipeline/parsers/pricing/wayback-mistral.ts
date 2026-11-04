import { VendorMdPricingOutput, modelKey, type PriceRow, type Provenance } from '../../contracts'
import { htmlSections, type HtmlSection } from './html-table'

// Mistral's own pricing pages as the Internet Archive captured them
// (archive/eras.ts names each era's URL and window):
//
//   2023-12 to 2024-04, docs.mistral.ai/platform/pricing: a table per API
//   ("Chat Completions API", "Embeddings API"). Until early 2024 it priced in
//   euros only; then it printed USD and EUR columns side by side.
//   2024-05 to 2025-02, mistral.ai/technology: under "Pay-as-you-go pricing",
//   each model family as a USD table followed by the same table in EUR.
//
// Only the USD prices are read: a price is stored as printed, never
// converted, and the store holds USD. A capture that prints euros only is
// skipped. The model id is the API name the page printed beside the price
// (an endpoint like `open-mistral-7b`, or an alias like
// `mistral-large-latest`), kept as printed: the live price list keys rows by
// API name too, so an alias printed then lands on its own key rather than
// being guessed onto a dated id. Fine-tuning prices are not read, as live.

const SLUG = /^[a-z0-9][a-z0-9.-]*$/

function base(slug: string, prov: Provenance): PriceRow {
  return {
    provider: 'mistral',
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

function finish(rows: PriceRow[], what: string) {
  const byKey = new Map<string, PriceRow>()
  for (const r of rows) {
    const held = byKey.get(keyOf(r))
    if (
      held &&
      (held.input_per_mtok !== r.input_per_mtok || held.output_per_mtok !== r.output_per_mtok)
    ) {
      throw new Error(`${what}: ${r.model_slug} printed twice at different prices`)
    }
    byKey.set(keyOf(r), held ?? r)
  }
  if (byKey.size === 0) throw new Error(`${what}: no USD token price rows`)
  return VendorMdPricingOutput.parse({
    rows: [...byKey.values()].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1)),
  })
}

/** "0.25$ / 1M tokens" | "$0.25 /1M tokens" | "$2" -> 0.25 | 2; "" -> null. Anything else throws. */
function usd(cell: string): number | null {
  if (cell === '') return null
  const m =
    cell.match(/^\$(\d+(?:\.\d+)?)(?: ?\/ ?1M tokens)?$/) ??
    cell.match(/^(\d+(?:\.\d+)?)\$ ?\/ ?1M tokens$/)
  if (!m) throw new Error(`cell does not print a USD price per million tokens: ${cell}`)
  return Number(m[1])
}

// ---- docs.mistral.ai/platform/pricing, 2023-12 to 2024-04 ---------------------

/**
 * The docs pricing tables: Model | Endpoint | Input (USD) | Output (USD) |
 * Input (EUR) | Output (EUR) for chat, Model | Endpoint | Input (USD) |
 * Input (EUR) for embeddings. The endpoint is the API id. A page whose
 * tables print no USD column (December 2023 to early 2024) is skipped.
 */
export function parseMistralDocsPricingHtml(html: string, prov: Provenance) {
  const sections = htmlSections(html)
  const apis = sections.filter((s) => /^(Chat Completions|Embeddings) API$/.test(s.heading))
  if (apis.length === 0) throw new Error('heading not found: Chat Completions API')
  const rows: PriceRow[] = []
  for (const s of apis) {
    for (const [header, ...body] of s.tables) {
      if (!header) continue
      if (!header.includes('Input (USD)')) {
        if (body.some((r) => r.some((c) => c.includes('€')))) {
          throw new Error(`${s.heading}: prices printed in euros only`)
        }
        throw new Error(`${s.heading}: columns changed: ${header.join(' | ')}`)
      }
      const at = (name: string) => header.indexOf(name)
      if (at('Endpoint') === -1) throw new Error(`${s.heading}: no Endpoint column`)
      for (const cells of body) {
        if (cells.length !== header.length) {
          throw new Error(`${s.heading}: row has ${cells.length} cells: ${cells[0]}`)
        }
        const slug = cells[at('Endpoint')]!
        if (!SLUG.test(slug)) throw new Error(`unrecognised endpoint: ${slug}`)
        rows.push({
          ...base(slug, prov),
          input_per_mtok: usd(cells[at('Input (USD)')]!),
          output_per_mtok: at('Output (USD)') === -1 ? null : usd(cells[at('Output (USD)')]!),
          notes: `${cells[0]}; ${s.heading}`,
        })
      }
    }
  }
  return finish(rows, 'docs.mistral.ai/platform/pricing')
}

// ---- mistral.ai/technology, 2024-05 to 2025-02 ----------------------------------

/**
 * A table is read as USD only when it prints no euro amount at all. The EUR
 * twin of a USD table is never read, including a twin with a stray dollar
 * cell (mid-2024 printed Mistral Embed's EUR output as "$0.1").
 */
const currencyOf = (table: string[][]) => {
  const cells = table.slice(1).flat()
  if (cells.some((c) => /€/.test(c))) return 'EUR'
  return cells.some((c) => /\$\d|\d\$/.test(c)) ? 'USD' : null
}

/**
 * "Pay-as-you-go pricing": per family, a USD table and its EUR twin. Two
 * layouts. Mid-2024 tables have an unlabelled id column ("open-mistral-7b",
 * "mistral-large-2402"), a description, then Input and Output. From late 2024
 * they are Model | API Name | Description | Input (/M tokens) | Output (/M
 * tokens). EUR tables and the fine-tuning tables (One-off training, Storage)
 * are not read. A model with no output price (embeddings, moderation) has
 * none stored.
 */
export function parseMistralTechnologyHtml(html: string, prov: Provenance) {
  const sections: HtmlSection[] = htmlSections(html)
  const start = sections.findIndex((s) => s.heading === 'Pay-as-you-go pricing')
  if (start === -1) throw new Error('heading not found: Pay-as-you-go pricing')
  const rows: PriceRow[] = []
  // The tables sit under the h1 and, on some captures, under small headings after it.
  for (const s of sections.slice(start)) {
    if (s !== sections[start] && s.level === 1) break
    for (const table of s.tables) {
      const [header, ...body] = table
      if (!header || header.some((h) => /training|Storage/i.test(h))) continue
      if (currencyOf(table) !== 'USD') continue
      const named = header[0] === 'Model' && header[1] === 'API Name'
      const bare = header[0] === '' && header[1] === ''
      if (!named && !bare) throw new Error(`Pay-as-you-go: columns changed: ${header.join(' | ')}`)
      const input = header.findIndex((h) => /^Input\b/.test(h))
      const output = header.findIndex((h) => /^Output\b/.test(h))
      if (input === -1 || output === -1)
        throw new Error(`no Input/Output columns: ${header.join(' | ')}`)
      for (const cells of body) {
        if (cells.length !== header.length) {
          throw new Error(`Pay-as-you-go: row has ${cells.length} cells: ${cells[0]}`)
        }
        const slug = named ? cells[1]! : cells[0]!
        if (!SLUG.test(slug)) throw new Error(`unrecognised API name: ${slug}`)
        rows.push({
          ...base(slug, prov),
          input_per_mtok: usd(cells[input]!),
          output_per_mtok: usd(cells[output]!),
          notes: named ? cells[0]! : null,
        })
      }
    }
  }
  return finish(rows, 'mistral.ai/technology')
}
