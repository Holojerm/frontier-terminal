import type { Lane } from '#layers/core/server/pipeline/lanes'
import { normalizeRankings } from './normalize'
import { parseOpenRouterRankings } from './parsers/openrouter-rankings'

// The OpenRouter rankings lane (registered in server/registries/lanes.ts).

export const ADOPTION_LANES: Readonly<Record<string, Lane>> = {
  // A rolling window of daily buckets: a day scrolling out was not un-observed, so no
  // removal is recorded. meta.as_of rides on the run's detail (`as_of <iso>`), since in each
  // row's payload it would mark every row modified every tick; /api/rankings reads it from
  // the newest run carrying it.
  'openrouter-rankings-daily': {
    sides: [],
    removals: 'append-only',
    parse: (text, { prov, snapshotId }) => {
      const { rows, as_of } = parseOpenRouterRankings(text, prov)
      return { entities: normalizeRankings(rows, snapshotId), note: `as_of ${as_of}` }
    },
  },
}
