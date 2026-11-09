import {
  registerParser,
  VendorMdPricingOutput,
  type PriceRow,
  type Provenance,
} from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'
import { tableAfterHeading } from './md-table'

// meta-models-md — https://dev.meta.ai/docs/models.md, joined with each
// token-priced text line's own page (meta-muse-wonder-md, meta-muse-spark-md,
// meta-muse-ember-md).
// Catalog parser: prints no prices (they come from meta-pricing-md), so every
// price field stays null. What it adds is which ids Model API serves and
// their context window.
//
// models.md gives each line a `## <line>` section with a Model ID table; a
// line whose table's Output is exactly "Text" is a token-priced text line
// (Muse Image prints "Image", Voice "Text transcript", SAM "Boxes and masks",
// and the open-weight Muse Glimmer and Muse Spark Open print no table). Its
// context window is the table's "Context window" column where it has one;
// Muse Ember's table (added 2026-11-09) has none, and the window is the
// "Context window" row of its own page's "## At a glance" table instead. Until 2026-11-06 the page also carried a
// "### <line> availability" table per line; since then that table is the
// "## Availability" section of the line's own page, unchanged. Its rows name
// an id in backticks and say whether pay-as-you-go serves it; a row with no
// id ("Muse Wonder Full") or "Not available" there is a Muse Code-only
// variant and is not an API SKU. The rows are the ones the single page gave.
//
// It fails loudly, never quietly short: on a text line with no registered
// page (META_LINE_PAGES), and on an id models.md lists that its page's
// availability table does not.

const API_COLUMN = 'Model API (pay-as-you-go)'
const NOT_AVAILABLE = 'Not available'
const CONTEXT_COLUMN = 'Context window'
const OUTPUT_COLUMN = 'Output'
const TEXT_OUTPUT = 'Text'
const AVAILABILITY_HEADING = '## Availability'
const AT_A_GLANCE_HEADING = '## At a glance'
const CONTEXT_ROW = '**Context window**'
// "1,048,576 tokens"
const CONTEXT = /^([\d,]+) tokens$/
const PREVIEW_NOTE = '> **NOTE: Preview**'

/** Each token-priced text line's own page, by its models.md heading. */
export const META_LINE_PAGES: Readonly<Record<string, string>> = {
  'Muse Wonder': 'meta-muse-wonder-md',
  'Muse Spark': 'meta-muse-spark-md',
  'Muse Ember': 'meta-muse-ember-md',
}

/** Each line page's committed fixture, for the registry's determinism gate. */
const SIDE_FIXTURES: Readonly<Record<string, string>> = {
  'meta-muse-wonder-md': 'fixtures/pricing/meta-muse-wonder.md',
  'meta-muse-spark-md': 'fixtures/pricing/meta-muse-spark.md',
  'meta-muse-ember-md': 'fixtures/pricing/meta-muse-ember.md',
}

/** The `## ` section headings of a page, in order. */
const sectionHeadings = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^## /.test(l))

/** The first table of a section, or null when the section has none. */
function firstTable(text: string, heading: string): string[][] | null {
  try {
    return tableAfterHeading(text, heading)
  } catch {
    return null
  }
}

/** A row's value in a line page's two-column "## At a glance" table. */
function atAGlance(page: string, pageId: string, label: string): string {
  const table = firstTable(page, AT_A_GLANCE_HEADING)
  if (!table) throw new Error(`${pageId}: no ${AT_A_GLANCE_HEADING} table`)
  const row = table.find((cells) => cells[0] === label)
  if (!row || !row[1]) throw new Error(`${pageId} ${AT_A_GLANCE_HEADING}: no ${label} row`)
  return row[1]
}

// prov defaults to the fixture manifest's record (single-arg behavior is
// byte-identical for the determinism gate); the refresh orchestrator passes
// the live fetch's provenance instead. `side` reads a join page by source id.
export function parseMetaModelsMd(
  text: string,
  side: (sourceId: string) => string,
  prov: Provenance = fixtureProvenance('meta-models-md'),
) {
  const rows: PriceRow[] = []
  for (const heading of sectionHeadings(text)) {
    const table = firstTable(text, heading)
    const header = table?.[0] ?? []
    const contextAt = header.indexOf(CONTEXT_COLUMN)
    const outputAt = header.indexOf(OUTPUT_COLUMN)
    if (!table || header[0] !== 'Model ID') continue
    const textLine =
      contextAt !== -1 ||
      (outputAt !== -1 &&
        table.length > 1 &&
        table.slice(1).every((cells) => cells[outputAt] === TEXT_OUTPUT))
    if (!textLine) continue

    const line = heading.slice(3)
    const pageId = META_LINE_PAGES[line]
    if (!pageId) {
      throw new Error(`${line}: a text line with no page in META_LINE_PAGES`)
    }
    const listed = table
      .slice(1)
      .flatMap((cells) =>
        [...(cells[0] ?? '').matchAll(/`([^`]+)`/g)].map((m) => ({ id: m[1]!, cells })),
      )
    if (!listed.length) throw new Error(`${line}: Model ID table names no id`)

    const page = side(pageId)
    const printed =
      contextAt !== -1
        ? listed.map(({ cells }) => cells[contextAt])
        : [atAGlance(page, pageId, CONTEXT_ROW)]
    const contexts = new Set(printed.map((cell) => cell?.match(CONTEXT)?.[1]))
    const [context] = contexts
    if (contexts.size !== 1 || !context) {
      throw new Error(`${line}: no single context window printed: ${[...printed].join(', ')}`)
    }

    const preview = page.includes(PREVIEW_NOTE)
    const availability = tableAfterHeading(page, AVAILABILITY_HEADING)
    if (availability[0]?.[1] !== API_COLUMN) {
      throw new Error(
        `${pageId} ${AVAILABILITY_HEADING}: second column is not "${API_COLUMN}": ${availability[0]?.[1]}`,
      )
    }
    const onPage = new Set<string>()
    for (const cells of availability.slice(1)) {
      const api = cells[1] ?? ''
      const id = cells[0]!.match(/`([^`]+)`/)?.[1]
      if (id) onPage.add(id)
      if (api === NOT_AVAILABLE) continue
      if (!id) throw new Error(`${pageId}: API-available row names no id: ${cells[0]}`)
      const name = cells[0]!.replace(/\s*\(`[^`]+`\)\s*$/, '')
      rows.push({
        provider: 'meta',
        model_slug: id,
        tier: null,
        context_window: `${context} tokens`, // as printed
        input_per_mtok: null, // page prints no prices — stays null, never guessed
        cached_input_per_mtok: null,
        output_per_mtok: null,
        currency: 'USD',
        effective_from: null,
        effective_until: null,
        notes: [name, `Model API: ${api}`, ...(preview ? ['preview'] : [])].join('; '),
        ...prov,
      })
    }
    const missing = listed.map((l) => l.id).filter((id) => !onPage.has(id))
    if (missing.length) {
      throw new Error(`${line}: models.md lists ${missing.join(', ')}, absent from ${pageId}`)
    }
  }
  if (rows.length === 0) throw new Error('no Model ID table with a context window found')

  rows.sort((a, b) => (a.model_slug < b.model_slug ? -1 : a.model_slug > b.model_slug ? 1 : 0))
  return VendorMdPricingOutput.parse({ rows })
}

registerParser({
  name: 'meta-models-md',
  lane: 'vendor-md',
  fixturePath: 'fixtures/pricing/meta-models.md',
  sideFixturePaths: Object.values(SIDE_FIXTURES),
  schema: VendorMdPricingOutput,
  parse: (text, side) => parseMetaModelsMd(text, (id) => side(SIDE_FIXTURES[id]!)),
})
