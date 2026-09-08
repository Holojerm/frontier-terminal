import { registerParser, OpenRouterOutput, type Provenance, type Provider } from '../contracts'
import { fixtureProvenance } from './fixture-provenance'

// OpenRouter model list — CROSS-CHECK ONLY, never source of record
// (sources.yaml: third-party restatement, no drift SLA, thin xAI coverage —
// 6 SKUs vs 20+ vendor-side). Downstream compares these rows against
// vendor-stated prices to detect drift; no price from here is ever
// presented as a provider's own word.

const SOURCE_ID = 'openrouter-models'

const prefixToProvider: Record<string, Provider> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  'x-ai': 'xai',
}

/** The lab behind an OpenRouter id ("anthropic/claude-…") from its prefix;
 * everything else — other vendors, and the rankings' aggregated `other`
 * row, which has no prefix at all — is 'other'. Shared with the rankings
 * parser so the two OpenRouter feeds cannot map a prefix differently. */
export function providerOfOpenRouterId(id: string): Provider {
  return prefixToProvider[id.split('/')[0] ?? ''] ?? 'other'
}

interface OrModel {
  id: string
  context_length?: number | null
  pricing?: { prompt?: string | null; completion?: string | null } | null
}

// OpenRouter prints prices as decimal strings in USD per single token
// (schema field names say per_tok, not per_mtok — unit conversion is
// normalize-stage work, not parse-stage). "-1" marks dynamic routing, i.e.
// "no fixed price" → null, not a price.
function toPerTok(value: string | null | undefined): number | null {
  if (value == null) return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

// prov defaults to the fixture manifest's record (single-arg behavior is
// byte-identical for the determinism gate); the refresh orchestrator passes
// the live fetch's provenance instead.
export function parseOpenRouter(
  fixtureText: string,
  prov: Provenance = fixtureProvenance(SOURCE_ID),
) {
  const { source_url, fetched_at } = prov
  const models = (JSON.parse(fixtureText) as { data: OrModel[] }).data
  const rows = models
    .map((m) => ({
      or_model_id: m.id,
      provider: providerOfOpenRouterId(m.id),
      prompt_per_tok: toPerTok(m.pricing?.prompt),
      completion_per_tok: toPerTok(m.pricing?.completion),
      context_length: typeof m.context_length === 'number' ? m.context_length : null,
      source_url,
      fetched_at,
    }))
    // stable sort key = or_model_id (unique in source) — determinism-gate food
    .sort((a, b) => (a.or_model_id < b.or_model_id ? -1 : a.or_model_id > b.or_model_id ? 1 : 0))
  return OpenRouterOutput.parse({ rows })
}

registerParser({
  name: SOURCE_ID,
  lane: 'cross-check',
  fixturePath: 'fixtures/pricing/openrouter-models.json',
  sideFixturePaths: [],
  schema: OpenRouterOutput,
  parse: (text) => parseOpenRouter(text),
})
