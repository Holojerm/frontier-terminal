import type { Lane } from '#layers/core/server/pipeline/lanes'
import { normalizeIncidents } from './normalize'
import { parseAnthropicStatus } from './parsers/status/anthropic-status'
import { DEEPSEEK_ATOM, parseDeepseekStatus } from './parsers/status/deepseek-status'
import { parseGoogleCloudStatus } from './parsers/status/google-cloud-status'
import { parseMistralStatus } from './parsers/status/mistral-status'
import { parseOpenaiStatus } from './parsers/status/openai-status'
import { parseXaiStatus } from './parsers/status/xai-status'

// The status feeds' lanes. Registered in server/registries/lanes.ts.

export const RELIABILITY_LANES: Readonly<Record<string, Lane>> = {
  // Status feeds are rolling windows (Statuspage caps at 50; OpenAI's page
  // holds about a month), so an incident scrolling out was not un-posted.
  // An incident that resolves diffs as 'modified' (resolved_at null → set).
  'openai-status': {
    sides: [],
    removals: 'append-only',
    parse: (text, { prov, snapshotId }) => ({
      entities: normalizeIncidents(parseOpenaiStatus(text, prov).rows, snapshotId),
    }),
  },
  'anthropic-status': {
    sides: [],
    removals: 'append-only',
    parse: (text, { prov, snapshotId }) => {
      const { rows, maintenances } = parseAnthropicStatus(text, prov)
      return {
        entities: normalizeIncidents(rows, snapshotId),
        note: maintenances ? `${maintenances} scheduled maintenances skipped` : undefined,
      }
    },
  },
  'mistral-status': {
    sides: [],
    removals: 'append-only',
    parse: (text, { prov, snapshotId }) => ({
      entities: normalizeIncidents(parseMistralStatus(text, prov).rows, snapshotId),
    }),
  },
  // The RSS feed gives each incident's start; its Atom twin, fetched in the
  // same tick, gives a resolved incident's end.
  'deepseek-status': {
    sides: [DEEPSEEK_ATOM],
    removals: 'append-only',
    parse: (text, { prov, snapshotId, side }) => ({
      entities: normalizeIncidents(
        parseDeepseekStatus(text, side(DEEPSEEK_ATOM), prov).rows,
        snapshotId,
      ),
    }),
  },
  'xai-status': {
    sides: [],
    removals: 'append-only',
    parse: (text, { prov, snapshotId }) => ({
      entities: normalizeIncidents(parseXaiStatus(text, prov).rows, snapshotId),
    }),
  },
  'google-cloud-status': {
    sides: [],
    removals: 'append-only',
    parse: (text, { prov, snapshotId }) => {
      const { rows, skipped } = parseGoogleCloudStatus(text, prov)
      return {
        entities: normalizeIncidents(rows, snapshotId),
        note: skipped ? `${skipped} incidents skipped: no Gemini / Vertex AI product` : undefined,
      }
    },
  },
}
