import { setLane, type Lane } from '#layers/core/server/pipeline/lanes'
import { normalizeJobs } from './normalize'
import { parseAnthropicGreenhouse } from './parsers/hiring/anthropic-greenhouse'
import { parseGoogleCareers } from './parsers/hiring/google-careers'
import { parseMistralAshby } from './parsers/hiring/mistral-ashby'
import { parseOpenaiAshby } from './parsers/hiring/openai-ashby'
import { parseXaiGreenhouse } from './parsers/hiring/xai-greenhouse'

// The job boards' lanes. Every one is a 'set': the board IS the current list
// of open roles, so a role that leaves it closed. A Greenhouse board joins
// its /departments payload, fetched as a side in the same tick. Registered in
// server/registries/lanes.ts.

const set = setLane

export const TALENT_LANES: Readonly<Record<string, Lane>> = {
  'openai-ashby': set((text, { prov, snapshotId }) => ({
    entities: normalizeJobs(parseOpenaiAshby(text, prov).rows, snapshotId),
  })),
  'mistral-ashby': set((text, { prov, snapshotId }) => ({
    entities: normalizeJobs(parseMistralAshby(text, prov).rows, snapshotId),
  })),
  // The feed is Alphabet-wide; only DeepMind's roles become rows, and the
  // rest are counted in the run note.
  'google-careers': set((text, { prov, snapshotId }) => {
    const { rows, skipped } = parseGoogleCareers(text, prov)
    return {
      entities: normalizeJobs(rows, snapshotId),
      note: skipped ? `not DeepMind, skipped: ${skipped}` : undefined,
    }
  }),
  'anthropic-greenhouse': {
    sides: ['anthropic-greenhouse-departments'],
    removals: 'set',
    parse: (text, { prov, snapshotId, side }) => ({
      entities: normalizeJobs(
        parseAnthropicGreenhouse(text, side('anthropic-greenhouse-departments'), prov).rows,
        snapshotId,
      ),
    }),
  },
  'xai-greenhouse': {
    sides: ['xai-greenhouse-departments'],
    removals: 'set',
    parse: (text, { prov, snapshotId, side }) => ({
      entities: normalizeJobs(
        parseXaiGreenhouse(text, side('xai-greenhouse-departments'), prov).rows,
        snapshotId,
      ),
    }),
  },
}
