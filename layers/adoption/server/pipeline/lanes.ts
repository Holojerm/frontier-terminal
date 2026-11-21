import type { Lane } from '#layers/core/server/pipeline/lanes'
import { normalizeRankings } from './normalize'
import { parseOpenRouterRankings } from './parsers/openrouter-rankings'

// The OpenRouter rankings lane. Registered in server/registries/lanes.ts. The
// feed is the source of record for the demand-share axis, held out as one
// aggregator's traffic rather than the market's.

export const ADOPTION_LANES: Readonly<Record<string, Lane>> = {
  // A rolling window of daily buckets: a day scrolling out of the window was
  // not un-observed, so no removal is recorded and the series accumulates.
  // meta.as_of rides on the run's detail (`as_of <iso>`) rather than in each
  // row's payload, where it would mark every row modified on every tick;
  // /api/rankings reads it back from the newest run that carries it.
  'openrouter-rankings-daily': {
    sides: [],
    removals: 'append-only',
    parse: (text, { prov, snapshotId }) => {
      const { rows, as_of } = parseOpenRouterRankings(text, prov)
      return { entities: normalizeRankings(rows, snapshotId), note: `as_of ${as_of}` }
    },
  },
}
