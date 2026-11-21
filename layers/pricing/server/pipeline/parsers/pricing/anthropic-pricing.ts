import {
  registerParser,
  VendorMdPricingOutput,
  modelKey,
  type PriceRow,
  type Provenance,
} from '../../../../../core/server/utils/contracts'
import { fixtureProvenance } from '../../../../../core/server/utils/fixture-provenance'
import { isoDate, tableAfterHeading, usdAmount } from './md-table'

// anthropic-pricing-md — https://platform.claude.com/docs/en/about-claude/pricing.md
// Two per-model $/MTok tables are parsed:
//   "## Model pricing"      -> base rows (tier null)
//   "### Batch processing"  -> tier "batch" rows (50% list discount, printed)
// A model priced by prompt length prints two rows, "Claude Haiku 5.5 (for
// prompts up to 100,000 tokens)" and "(… over 100,000 tokens)". The short band
// keeps the plain tier (null / "batch") so it joins the catalog row from
// anthropic-models-md, whose "From" price it is; the long band is
// "long_context" / "batch_long_context", the names openai-pricing-md uses.
// Column mapping: input = "Base Input Tokens", cached input = "Cache Hits &
// Refreshes" (the price paid to READ cached input — the analog of OpenAI's
// "cached input" and xAI's "Cached input / 1M tokens"). The 5m/1h cache
// WRITE prices have no schema column; they ride verbatim in notes so a
// cache-tier repricing still changes the row's content hash and diffs.
// The fast-mode table (one combined two-model row) is deliberately not
// parsed.
//
// A launch can price a model on a schedule (Claude Sonnet 5, June 2026): one
// row "through August 31, 2026" (a link to the note saying so) and one
// "starting September 1, 2026". The first ends the day after its last day and
// the second starts then, the shape openai-pricing gives a promotion, so the
// scheduled row keys as `standard@<date>` (normalize.ts › priceTier). A
// schedule we can't date fails the source rather than storing a future price
// as today's.

// "Claude Opus 4.1 ([retired, except on Bedrock and Google Cloud](url))"
const NAME_WITH_ANNOTATION = /^(.*?)\s*\(\[([^\]]+)\]\([^)]*\)\)$/

/** Vendor slug convention, verified against the models-overview fixture's
 * "Claude API alias" row for all four current models ("Claude Haiku 4.5"
 * -> claude-haiku-4-5). INFERENCE for retired models absent from the
 * overview (e.g. claude-opus-4-1): derived, not read from a printed id. */
export function anthropicSlug(displayName: string): string {
  return displayName.toLowerCase().replace(/\./g, '-').replace(/\s+/g, '-')
}

// "Claude Haiku 5.5 (for prompts up to 100,000 tokens)"
const PROMPT_BAND = /^(.*?)\s*\(for prompts (up to|over) ([\d,]+) tokens\)$/

interface ModelCell {
  name: string
  annotation: string | null
  /** Set when the row is one prompt-length band of a model. */
  band: { long: boolean; note: string } | null
  /** Set when the row is one period of a scheduled price. */
  dated?: { effective_from: string | null; effective_until: string | null; note: string }
}

// "Claude Sonnet 5 [through August 31, 2026](/docs/…#…)" and "Claude Sonnet 5 starting September 1, 2026"
const THROUGH = /^(.*?)\s*\[?through ([A-Z][a-z]+ \d{1,2}, \d{4})\]?(?:\([^)]*\))?$/
const STARTING = /^(.*?)\s+starting ([A-Z][a-z]+ \d{1,2}, \d{4})$/

const dayAfter = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

function datedOf(printed: string): string {
  const iso = isoDate(printed)
  if (!iso) throw new Error(`a scheduled price with a date we can't read: ${printed}`)
  return iso
}

function splitModelCell(cell: string): ModelCell {
  const through = cell.match(THROUGH)
  if (through) {
    return {
      name: through[1]!,
      annotation: null,
      band: null,
      dated: {
        effective_from: null,
        effective_until: dayAfter(datedOf(through[2]!)),
        note: `through ${through[2]!}`,
      },
    }
  }
  const starting = cell.match(STARTING)
  if (starting) {
    return {
      name: starting[1]!,
      annotation: null,
      band: null,
      dated: {
        effective_from: datedOf(starting[2]!),
        effective_until: null,
        note: `starting ${starting[2]!}`,
      },
    }
  }
  const band = cell.match(PROMPT_BAND)
  if (band) {
    const long = band[2] === 'over'
    return {
      name: band[1]!,
      annotation: null,
      band: {
        long,
        note: `${long ? 'long' : 'short'} context: prompts ${band[2]} ${band[3]} tokens`,
      },
    }
  }
  const m = cell.match(NAME_WITH_ANNOTATION)
  return m
    ? { name: m[1]!, annotation: m[2]!, band: null }
    : { name: cell, annotation: null, band: null }
}

// prov defaults to the fixture manifest's record (single-arg behavior is
// byte-identical for the determinism gate); the refresh orchestrator passes
// the live fetch's provenance instead.
export function parseAnthropicPricingMd(
  text: string,
  prov: Provenance = fixtureProvenance('anthropic-pricing-md'),
) {
  const rows: PriceRow[] = []

  // Header: | Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |
  const base = tableAfterHeading(text, '## Model pricing')
  for (const cells of base.slice(1)) {
    if (cells.length < 6) throw new Error(`model pricing row has ${cells.length} cells`)
    const { name, annotation, band, dated } = splitModelCell(cells[0]!)
    const notes = [
      ...(annotation ? [annotation] : []),
      ...(band ? [band.note] : []),
      ...(dated ? [dated.note] : []),
      `5m cache writes ${cells[2]!}`,
      `1h cache writes ${cells[3]!}`,
    ].join('; ')
    rows.push({
      provider: 'anthropic',
      model_slug: anthropicSlug(name),
      tier: band?.long ? 'long_context' : null,
      context_window: null, // not printed on the pricing page (catalog: anthropic-models-md)
      input_per_mtok: usdAmount(cells[1]!),
      cached_input_per_mtok: usdAmount(cells[4]!),
      output_per_mtok: usdAmount(cells[5]!),
      currency: 'USD',
      effective_from: dated?.effective_from ?? null,
      effective_until: dated?.effective_until ?? null,
      notes,
      ...prov,
    })
  }

  // Header: | Model | Batch input | Batch output |
  const batch = tableAfterHeading(text, '### Batch processing')
  for (const cells of batch.slice(1)) {
    if (cells.length < 3) throw new Error(`batch pricing row has ${cells.length} cells`)
    const { name, annotation, band, dated } = splitModelCell(cells[0]!)
    rows.push({
      provider: 'anthropic',
      model_slug: anthropicSlug(name),
      tier: band?.long ? 'batch_long_context' : 'batch',
      context_window: null,
      input_per_mtok: usdAmount(cells[1]!),
      cached_input_per_mtok: null, // batch table prints no cached-input price
      output_per_mtok: usdAmount(cells[2]!),
      currency: 'USD',
      effective_from: dated?.effective_from ?? null,
      effective_until: dated?.effective_until ?? null,
      notes: band ? band.note : dated ? dated.note : annotation,
      ...prov,
    })
  }

  rows.sort((a, b) => {
    const ka = modelKey(a.provider, a.model_slug, a.tier)
    const kb = modelKey(b.provider, b.model_slug, b.tier)
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
  return VendorMdPricingOutput.parse({ rows })
}

registerParser({
  name: 'anthropic-pricing-md',
  lane: 'vendor-md',
  fixturePath: 'fixtures/pricing/anthropic-pricing.md',
  sideFixturePaths: [],
  schema: VendorMdPricingOutput,
  parse: (text) => parseAnthropicPricingMd(text),
})
