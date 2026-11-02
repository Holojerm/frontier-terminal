import {
  registerParser,
  VendorMdPricingOutput,
  modelKey,
  type PriceRow,
  type Provenance,
} from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'
import { tableAfterHeading, usdAmount } from './md-table'

// meta-pricing-md — https://dev.meta.ai/docs/pricing-rate-limits.md
// Meta prices a model LINE, not a version: "### Muse Spark" carries one
// table for every Muse Spark id, and the sentence above it says which ids
// that is ("Models: `muse-spark-1.3`, … in Standard mode;
// `muse-spark-1.3-contributor` … in Contributor mode."). Each named id gets
// the column for its mode. Contributor mode is a distinct model id the
// caller selects, so it is a row of its own (tier null), not a tier of the
// Standard id — the same way OpenRouter lists it.
//
// Only the token-priced lines are parsed: a "### " section under
// "## Model pricing" whose table header is the Standard/Contributor $/MTok
// pair. Muse Image, Muse Voice Transcribe and SAM print per-image, per-hour
// and per-frame tables with a different header and are skipped by that test.

const PRICING_HEADING = '## Model pricing'
const TOKEN_HEADER = ['Usage', 'Standard mode (per 1M tokens)', 'Contributor mode (per 1M tokens)']
// "Model: `muse-wonder-1.0`." | "Models: `a`, `b` in Standard mode; `c` in Contributor mode."
const MODELS_SENTENCE = /^Models?: (.+?\.)(?:\s|$)/
const NOT_AVAILABLE = 'Not available'

type Mode = 'Standard' | 'Contributor'

/** The `### ` headings directly under `## Model pricing`, in page order. */
function lineHeadings(text: string): string[] {
  const lines = text.split('\n').map((l) => l.trim())
  const start = lines.indexOf(PRICING_HEADING)
  if (start === -1) throw new Error(`heading not found: ${PRICING_HEADING}`)
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line)) break
    if (/^### /.test(line)) out.push(line)
  }
  return out
}

/** Model ids per mode from the sentence between a line's heading and its table. */
function idsByMode(text: string, heading: string): Map<Mode, string[]> {
  const lines = text.split('\n')
  const at = lines.findIndex((l) => l.trim() === heading)
  const sentence = lines
    .slice(at + 1)
    .map((l) => l.trim())
    .find((l) => MODELS_SENTENCE.test(l))
  const m = sentence?.match(MODELS_SENTENCE)
  if (!m) throw new Error(`${heading}: no "Model:" sentence names the priced ids`)

  const out = new Map<Mode, string[]>()
  for (const clause of m[1]!.split(';')) {
    const ids = [...clause.matchAll(/`([^`]+)`/g)].map((x) => x[1]!)
    if (ids.length === 0) throw new Error(`${heading}: clause names no model id: ${clause}`)
    // A clause with no mode is the single-mode form ("Model: `muse-wonder-1.0`.").
    const mode = (clause.match(/in (Standard|Contributor) mode/)?.[1] ?? 'Standard') as Mode
    out.set(mode, [...(out.get(mode) ?? []), ...ids])
  }
  return out
}

// prov defaults to the fixture manifest's record (single-arg behavior is
// byte-identical for the determinism gate); the refresh orchestrator passes
// the live fetch's provenance instead.
export function parseMetaPricingMd(
  text: string,
  prov: Provenance = fixtureProvenance('meta-pricing-md'),
) {
  const rows: PriceRow[] = []
  for (const heading of lineHeadings(text)) {
    let table: string[][]
    try {
      table = tableAfterHeading(text, heading)
    } catch {
      continue // a prose-only section ("### Token pricing notes")
    }
    const header = table[0]?.join('|') ?? ''
    if (header !== TOKEN_HEADER.join('|')) {
      // A reshaped token table must fail loudly, not drop the line's prices.
      if (header.includes('per 1M tokens'))
        throw new Error(`${heading}: unrecognized header ${header}`)
      continue
    }

    const usage = (label: string) => {
      const row = table.find((r) => r[0] === label)
      if (!row || row.length < 3) throw new Error(`${heading}: no "${label}" row`)
      return row
    }
    const input = usage('Input')
    const cached = usage('Cached input')
    const output = usage('Output')

    for (const [mode, ids] of idsByMode(text, heading)) {
      const col = mode === 'Standard' ? 1 : 2
      if (input[col] === NOT_AVAILABLE) {
        throw new Error(
          `${heading}: ${ids.join(', ')} named in ${mode} mode, priced "Not available"`,
        )
      }
      for (const slug of ids) {
        rows.push({
          provider: 'meta',
          model_slug: slug,
          tier: null,
          context_window: null, // not printed here (catalog: meta-models-md)
          input_per_mtok: usdAmount(input[col]!),
          cached_input_per_mtok: usdAmount(cached[col]!),
          output_per_mtok: usdAmount(output[col]!),
          currency: 'USD',
          effective_from: null,
          effective_until: null,
          notes:
            mode === 'Contributor'
              ? 'Contributor mode: Meta may use the content sent and returned to train future Meta models'
              : 'Standard mode',
          ...prov,
        })
      }
    }
  }
  if (rows.length === 0) throw new Error('no token-priced model line found')

  rows.sort((a, b) => {
    const ka = modelKey(a.provider, a.model_slug, a.tier)
    const kb = modelKey(b.provider, b.model_slug, b.tier)
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
  return VendorMdPricingOutput.parse({ rows })
}

registerParser({
  name: 'meta-pricing-md',
  lane: 'vendor-md',
  fixturePath: 'fixtures/pricing/meta-pricing.md',
  sideFixturePaths: [],
  schema: VendorMdPricingOutput,
  parse: (text) => parseMetaPricingMd(text),
})
