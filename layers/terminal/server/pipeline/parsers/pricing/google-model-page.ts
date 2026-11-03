import {
  GooglePricingOutput,
  registerParser,
  type PriceRow,
  type Provenance,
} from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'

// google-model-md-<slug> — https://aistudio.google.com/docs/models/<slug>.md
// One page per priced Standard-tier SKU, derived from google-pricing-html
// (layers/terminal/server/pipeline/derived.ts). The pricing page prints no context windows;
// this page does, in a "Property | Description" table whose "Token limits"
// row reads either
//   **Input token limit** 1,048,576 **Output token limit** 65,536
// or, on newer cards,
//   **Context window (unified input and output token limit)** 1,048,576 **Max output** 65,536 …
// The first number is stored as the context window, as printed; the whole
// cell, links unwrapped, is the row's note, so the label Google used and the
// max output travel with it. No prices: the page links to the pricing page
// instead. One row, tier "standard", so it shares the pricing row's key; the
// catalog view lends its window to every tier of the slug, citing this page.
//
// Two renderings of that table, both read:
//
//   Markdoc (from 2026-11-03, when ai.google.dev/gemini-api/docs/models/<slug>
//   began 301-ing to aistudio.google.com/docs/models/<slug> and the .md.txt
//   export started to 404): a `{% table %}` block (some carry
//   `variant="model"`) headed "Property | Description", whose rows
//   are separated by `---` lines and whose cells open with `* ` at the
//   table's own indent. A label cell wraps its text in `{% section %}` and
//   `{% icon /%}` tags, and "Token limits" carries a `[[*]](/docs/tokens)`
//   footnote, on some pages inside `{% sup %}`.
//
//   Markdown pipe table (the ai.google.dev .md.txt export, until 2026-11-03).
//
// A page can carry several model tables (the Robotics-ER page has three).
// The one read is the table whose "Model code" names the slug the source was
// derived for; no such table throws, and the source fails rather than
// storing a page under the wrong SKU.

const PROPERTY_HEADER = /^\|\s*Property\s*\|\s*Description\s*\|\s*$/
const CELLS = /^\|\s*(.+?)\s*\|\s*(.*?)\s*\|\s*$/
const WINDOW = /^\*\*(?:Input token limit|Context window[^*]*)\*\*\s*([\d,]+)/
const LINK = /\[([^\]]*)\]\([^)]*\)/g

const MD_TABLE = /\{% table(?: [^%]*)? %\}([\s\S]*?)\{% \/table %\}/g
const MD_ROW_RULE = /^[ \t]*---[ \t]*$/m
const MD_SUP = /\{% sup %\}[\s\S]*?\{% \/sup %\}/g
const MD_FOOTNOTE = /\[\[\*\]\]\([^)]*\)/g
const MD_TAG = /\{%[\s\S]*?%\}/g

/** Each pipe-table "Property | Description" table on the page, as label → value. */
function pipeTables(text: string): Map<string, string>[] {
  const tables: Map<string, string>[] = []
  let current: Map<string, string> | null = null
  for (const line of text.split('\n')) {
    if (PROPERTY_HEADER.test(line)) {
      current = new Map()
      tables.push(current)
      continue
    }
    if (!current) continue
    const cells = line.match(CELLS)
    if (!cells) {
      current = null
      continue
    }
    // "Token limits^[\[\*\]](…tokens)^" — the footnote marker is not the label.
    current.set(cells[1]!.replace(/\^.*$/, ''), cells[2]!)
  }
  return tables
}

/** A Markdoc cell's text: footnote markers and tags dropped, whitespace collapsed. */
const markdocCell = (cell: string) =>
  cell.replace(MD_SUP, '').replace(MD_FOOTNOTE, '').replace(MD_TAG, ' ').replace(/\s+/g, ' ').trim()

/** Each Markdoc "Property | Description" `{% table %}` on the page, as label → value. */
function markdocTables(text: string): Map<string, string>[] {
  const tables: Map<string, string>[] = []
  for (const [, body] of text.matchAll(MD_TABLE)) {
    // A cell opens with "* " at the shallowest indent a bullet has in this
    // table; deeper bullets belong to the cell above them.
    const indents = [...body!.matchAll(/^([ \t]*)\* /gm)].map((m) => m[1]!.length)
    if (!indents.length) continue
    const opener = new RegExp(`^[ \\t]{${Math.min(...indents)}}\\* `, 'm')
    const rows = body!
      .split(MD_ROW_RULE)
      .map((row) => row.split(opener).slice(1).map(markdocCell))
      .filter((cells) => cells.length)
    const [header, ...data] = rows
    if (header?.[0] !== 'Property' || header[1] !== 'Description') continue
    const table = new Map<string, string>()
    for (const [label, value] of data) if (label) table.set(label, value ?? '')
    tables.push(table)
  }
  return tables
}

/** Each "Property | Description" table on the page, in either rendering. */
function propertyTables(text: string): Map<string, string>[] {
  return [...markdocTables(text), ...pipeTables(text)]
}

const codesIn = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!)

export function parseGoogleModelPage(
  text: string,
  expectedSlug: string,
  prov: Provenance = fixtureProvenance('google-model-md-gemini-4-argon'),
) {
  const tables = propertyTables(text)
  const table = tables.find((t) => codesIn(t.get('Model code') ?? '').includes(expectedSlug))
  if (!table) {
    const printed = tables.flatMap((t) => codesIn(t.get('Model code') ?? ''))
    if (!printed.length) throw new Error('model page prints no "Model code"')
    throw new Error(`model page is for ${printed.join(', ')}, derived for ${expectedSlug}`)
  }

  const limits = table.get('Token limits') ?? null
  const row: PriceRow = {
    provider: 'google',
    model_slug: expectedSlug,
    tier: 'standard',
    context_window: limits?.match(WINDOW)?.[1] ?? null, // as printed ("1,048,576")
    input_per_mtok: null,
    cached_input_per_mtok: null,
    output_per_mtok: null,
    currency: 'USD',
    effective_from: null,
    effective_until: null,
    notes: limits?.replace(LINK, '$1').replace(/\*\*/g, '').trim() || null,
    ...prov,
  }
  return GooglePricingOutput.parse({ rows: [row] })
}

registerParser({
  name: 'google-model-md-gemini-4-argon',
  lane: 'vendor-md',
  fixturePath: 'fixtures/pricing/google-model-gemini-4-argon.md',
  sideFixturePaths: [],
  schema: GooglePricingOutput,
  parse: (text) => parseGoogleModelPage(text, 'gemini-4-argon'),
})
