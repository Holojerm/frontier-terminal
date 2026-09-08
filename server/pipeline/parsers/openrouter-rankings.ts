import { registerParser, OpenRouterRankingsOutput, type Provenance } from '../contracts'
import { fixtureProvenance } from './fixture-provenance'
import { providerOfOpenRouterId } from './openrouter'

// OpenRouter daily usage rankings — the demand-share axis. For labs that are
// still private, one aggregator's token traffic is the best public proxy for
// relative demand; it is OpenRouter share, not market share, and every
// surface that shows it says so (sources.yaml caveats).
//
// Documented shape (openrouter.ai/docs/cookbook/administration/data-api):
//   data[]: { date: "YYYY-MM-DD", model_permaslug, total_tokens: "<digits>" }
//   meta:   { as_of, version, start_date, end_date }
// Top 50 public models per UTC day plus one aggregated `other` row. Data is
// CC BY 4.0; the required citation travels with meta.as_of.

const SOURCE_ID = 'openrouter-rankings-daily'

// total_tokens arrives as a decimal string. Only a string of digits (or an
// integer already) that fits a safe integer is a count; anything else is a
// schema drift worth failing the run over, never a zero.
function toTokens(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  const n = Number(value)
  return Number.isSafeInteger(n) ? n : null
}

interface RawRow {
  date?: unknown
  model_permaslug?: unknown
  total_tokens?: unknown
}

// prov defaults to the fixture manifest's record (the determinism gate runs
// the single-arg form); the refresh orchestrator passes the live fetch's.
export function parseOpenRouterRankings(
  text: string,
  prov: Provenance = fixtureProvenance(SOURCE_ID),
) {
  const { source_url, fetched_at } = prov
  const payload = JSON.parse(text) as { data?: unknown; meta?: { as_of?: unknown } }
  if (!Array.isArray(payload.data)) throw new Error('rankings payload has no data array')

  const rows = (payload.data as RawRow[])
    .map((r, i) => {
      const total_tokens = toTokens(r.total_tokens)
      if (total_tokens === null) {
        throw new Error(
          `data[${i}].total_tokens is not a non-negative integer: ${JSON.stringify(r.total_tokens)}`,
        )
      }
      const model_permaslug = typeof r.model_permaslug === 'string' ? r.model_permaslug : ''
      return {
        provider: providerOfOpenRouterId(model_permaslug),
        date: typeof r.date === 'string' ? r.date : '',
        model_permaslug,
        total_tokens,
        source_url,
        fetched_at,
      }
    })
    // Stable order: (date, permaslug) is the entity key, so it is a total order.
    .sort((a, b) =>
      a.date !== b.date
        ? a.date < b.date
          ? -1
          : 1
        : a.model_permaslug < b.model_permaslug
          ? -1
          : a.model_permaslug > b.model_permaslug
            ? 1
            : 0,
    )
  return OpenRouterRankingsOutput.parse({ rows, as_of: payload.meta?.as_of })
}

registerParser({
  name: SOURCE_ID,
  lane: 'cross-check',
  fixturePath: 'fixtures/rankings/openrouter-rankings-daily.json',
  sideFixturePaths: [],
  schema: OpenRouterRankingsOutput,
  parse: (text) => parseOpenRouterRankings(text),
})
