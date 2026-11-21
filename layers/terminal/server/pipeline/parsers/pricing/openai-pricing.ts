import {
  registerParser,
  VendorMdPricingOutput,
  modelKey,
  type PriceRow,
  type Provenance,
} from '#layers/core/server/pipeline/contracts'
import { fixtureProvenance } from '#layers/core/server/pipeline/parsers/fixture-provenance'
import { isoDate, tablesUnderHeading, usdAmount } from './md-table'

// openai-pricing-md — https://developers.openai.com/api/docs/pricing.md
// The markdown twin of the platform pricing page, which did not exist at
// the 2026-08-25 audit (the marketing page is Cloudflare-403'd; the models
// page prints no prices). One section per service tier — Standard, Batch,
// Flex, Fast, Ultrafast — each a current-model table with short- and
// long-context columns, most followed by a legacy table that prints one
// band (Input | Output | Cached input).
//
// One PriceRow per (model, service tier, context band). The Standard
// short-context row carries tier null so it shares modelKey with the
// catalog row from openai-models-md and the two pages read as one SKU
// (the Anthropic pair works the same way); every other band is its own
// tier and never collapsed or averaged. A legacy row is that tier's
// short-context row. A "(<272K context length)" annotation on a model cell
// is the short-context bound: it is kept verbatim in notes, never turned
// into a context_window the page does not print. The cache-write columns
// have no PriceRow field and are not stored. Columns are read by name, so
// a reorder is harmless; an added or dropped column still throws. The
// "Grouped Pricing Table" sections (cyber, audio, image, realtime, tools)
// are not the token price list and are deliberately not parsed.
//
// A launch can price Ultrafast on a schedule (GPT-6.2 Astra and Sol,
// 2026-11-17): a "promotion" table in force now and a "list" table from a
// date the page prints only in prose ("… through February 28, 2027, and 6
// times the Standard rate starting March 1, 2027"). The promotion rows end
// on that date and the list rows start on it, the shape google-pricing gives
// a promo cell, so the list rows key as `ultrafast@<date>` (normalize.ts ›
// priceTier). The two tables come and go together, and never without the
// date: a schedule we cannot date fails the source rather than storing a
// future price as today's.

type Window = 'promotion' | 'list'

const TABLES: readonly {
  heading: string
  tier: string | null
  long: string
  window?: Window
}[] = [
  { heading: '### Standard pricing data', tier: null, long: 'long_context' },
  { heading: '### Batch pricing data', tier: 'batch', long: 'batch_long_context' },
  { heading: '### Flex pricing data', tier: 'flex', long: 'flex_long_context' },
  { heading: '### Fast pricing data', tier: 'fast', long: 'fast_long_context' },
  { heading: '### Ultrafast pricing data', tier: 'ultrafast', long: 'ultrafast_long_context' },
  {
    heading: '### Ultrafast promotion pricing data',
    tier: 'ultrafast',
    long: 'ultrafast_long_context',
    window: 'promotion',
  },
  {
    heading: '### Ultrafast list pricing data',
    tier: 'ultrafast',
    long: 'ultrafast_long_context',
    window: 'list',
  },
]

// "…, and 6 times the Standard rate starting March 1, 2027 (Pacific time)."
const LIST_STARTS = /\bUltrafast costs [^\n]*?\bstarting ([A-Z][a-z]+ \d{1,2}, \d{4})/g

const hasHeading = (text: string, heading: string) =>
  text.split('\n').some((l) => l.trim() === heading)

/** The date the Ultrafast list price starts, or null when the page schedules none. */
function listStarts(text: string): string | null {
  const promotion = hasHeading(text, '### Ultrafast promotion pricing data')
  const list = hasHeading(text, '### Ultrafast list pricing data')
  if (promotion !== list) {
    throw new Error('Ultrafast promotion and list tables must appear together')
  }
  if (!promotion) return null
  const dates = new Set([...text.matchAll(LIST_STARTS)].map((m) => isoDate(m[1]!)))
  if (dates.size !== 1 || dates.has(null)) {
    throw new Error(`Ultrafast list pricing: expected one start date, found ${dates.size}`)
  }
  return [...dates][0]!
}

const CURRENT = [
  'Model',
  'Short context input',
  'Short context output',
  'Short context cached input',
  'Short context 30m write',
  'Short context 12h write',
  'Long context input',
  'Long context output',
  'Long context cached input',
  'Long context 30m write',
  'Long context 12h write',
] as const

const LEGACY = ['Model', 'Input', 'Output', 'Cached input'] as const

// "gpt-5.5 (<272K context length)"
const ANNOTATED = /^(\S+) \((.+)\)$/

const amount = (cell: string): number | null => (cell === '-' ? null : usdAmount(cell))

/** Column name -> index, or a throw when the header is not exactly `want` in some order. */
function columns<T extends string>(heading: string, header: string[], want: readonly T[]) {
  const same =
    header.length === want.length && [...header].sort().join('|') === [...want].sort().join('|')
  if (!same) throw new Error(`${heading}: columns changed: ${header.join(' | ')}`)
  return (name: T) => header.indexOf(name)
}

export function parseOpenAiPricingMd(
  text: string,
  prov: Provenance = fixtureProvenance('openai-pricing-md'),
) {
  const rows: PriceRow[] = []
  const changeDate = listStarts(text)
  for (const { heading, tier, long, window } of TABLES) {
    if (window && changeDate === null) continue
    const dated = {
      effective_from: window === 'list' ? changeDate : null,
      effective_until: window === 'promotion' ? changeDate : null,
    }
    const [current, legacy, ...rest] = tablesUnderHeading(text, heading)
    if (rest.length > 0)
      throw new Error(`${heading}: ${2 + rest.length} tables, expected at most 2`)
    const col = columns(heading, current![0] ?? [], CURRENT)
    const legacyCol = legacy ? columns(heading, legacy[0] ?? [], LEGACY) : null

    const each = (
      table: string[][],
      width: number,
      emit: (cells: string[], base: PriceRow) => void,
    ) => {
      for (const cells of table.slice(1)) {
        if (cells.length !== width) {
          throw new Error(`${heading}: row has ${cells.length} cells: ${cells[0]}`)
        }
        const m = cells[0]!.match(ANNOTATED)
        emit(cells, {
          provider: 'openai',
          model_slug: m ? m[1]! : cells[0]!,
          tier,
          context_window: null, // the page prints a short-context bound at most, never a window
          input_per_mtok: null,
          cached_input_per_mtok: null,
          output_per_mtok: null,
          currency: 'USD',
          ...dated,
          notes: m ? m[2]! : null,
          ...prov,
        })
      }
    }

    each(current!, CURRENT.length, (cells, base) => {
      const annotation = base.notes
      const at = (name: (typeof CURRENT)[number]) => amount(cells[col(name)]!)
      rows.push({
        ...base,
        input_per_mtok: at('Short context input'),
        cached_input_per_mtok: at('Short context cached input'),
        output_per_mtok: at('Short context output'),
        notes: annotation ? `short context: ${annotation}` : null,
      })
      const longInput = at('Long context input')
      const longOutput = at('Long context output')
      if (longInput !== null || longOutput !== null) {
        rows.push({
          ...base,
          tier: long,
          input_per_mtok: longInput,
          cached_input_per_mtok: at('Long context cached input'),
          output_per_mtok: longOutput,
          notes: annotation ? `long context: beyond ${annotation}` : 'long context',
        })
      }
    })

    if (legacy && legacyCol) {
      each(legacy, LEGACY.length, (cells, base) => {
        const at = (name: (typeof LEGACY)[number]) => amount(cells[legacyCol(name)]!)
        rows.push({
          ...base,
          input_per_mtok: at('Input'),
          cached_input_per_mtok: at('Cached input'),
          output_per_mtok: at('Output'),
          notes: base.notes ? `short context: ${base.notes}` : null,
        })
      })
    }
  }

  rows.sort((a, b) => {
    const ka = modelKey(a.provider, a.model_slug, a.tier)
    const kb = modelKey(b.provider, b.model_slug, b.tier)
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
  return VendorMdPricingOutput.parse({ rows })
}

registerParser({
  name: 'openai-pricing-md',
  lane: 'vendor-md',
  fixturePath: 'fixtures/pricing/openai-pricing.md',
  sideFixturePaths: [],
  schema: VendorMdPricingOutput,
  parse: (text) => parseOpenAiPricingMd(text),
})
