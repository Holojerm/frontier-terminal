import {
  AlertRow,
  FilingRow,
  contentHash,
  type ChangeRow,
  type EntityRow,
  type Provenance,
} from './contracts'
import { normalizeFilings, normalizeJobs, normalizePrices } from './normalize'
import { parseAnthropicGreenhouse } from './parsers/hiring/anthropic-greenhouse'
import { parseOpenaiAshby } from './parsers/hiring/openai-ashby'
import { parseXaiGreenhouse } from './parsers/hiring/xai-greenhouse'
import { parseAnthropicModelsOverviewMd } from './parsers/pricing/anthropic-models-overview'
import { parseAnthropicPricingMd } from './parsers/pricing/anthropic-pricing'
import { parseGooglePricingPage } from './parsers/pricing/google-pricing'
import { parseOpenAiModelsMd } from './parsers/pricing/openai-models'
import { parseXaiModelsMd } from './parsers/pricing/xai-models'
import { parseEdgarFts } from './parsers/sec/edgar-fts'
import { parseEdgarSubmissionsSpcx } from './parsers/sec/edgar-submissions'
import { isS1FloorForm } from './parsers/sec/s1-floor'
import type { CikWhitelist } from './parsers/sec/whitelist'

// How each include source turns a fetched body into entities — the join
// between the registry (which runs parsers on committed fixtures with fixture
// provenance) and a live tick (which stamps the fetch's own provenance and
// joins against payloads fetched in the same tick).
//
// A source with no lane is fetched and snapshotted but yields no entities:
// the Greenhouse /departments feeds exist to be joined, and OpenRouter is a
// cross-check that must never become a source of record (sources.yaml).

export interface ParseContext {
  prov: Provenance
  snapshotId: string
  /** Body of a side source fetched in this same tick; throws if it was not. */
  side: (sourceId: string) => string
  whitelist: CikWhitelist
}

export interface ParseResult {
  entities: EntityRow[]
  /** Anything the parser saw and deliberately did not turn into rows. */
  note?: string
}

export interface Lane {
  /** Source ids that must be fetched in the same tick for parse() to run. */
  sides: readonly string[]
  /**
   * 'set': the page IS the current set, so an entity that disappears is a
   * removal (a job closed, a model delisted). 'append-only': the feed is a
   * recent-filings window, and a filing scrolling out of it was not un-filed —
   * no removal is recorded and the entity stays.
   */
  removals: 'set' | 'append-only'
  parse(text: string, ctx: ParseContext): ParseResult
  alerts?: (changes: readonly ChangeRow[]) => AlertRow[]
}

const set = (parse: Lane['parse']): Lane => ({ sides: [], removals: 'set', parse })

export const LANES: Readonly<Record<string, Lane>> = {
  'openai-models-md': set((text, { prov, snapshotId }) => ({
    entities: normalizePrices(parseOpenAiModelsMd(text, prov).rows, snapshotId),
  })),
  'anthropic-models-md': set((text, { prov, snapshotId }) => ({
    entities: normalizePrices(parseAnthropicModelsOverviewMd(text, prov).rows, snapshotId),
  })),
  'anthropic-pricing-md': set((text, { prov, snapshotId }) => ({
    entities: normalizePrices(parseAnthropicPricingMd(text, prov).rows, snapshotId),
  })),
  'xai-models-md': set((text, { prov, snapshotId }) => ({
    entities: normalizePrices(parseXaiModelsMd(text, prov).rows, snapshotId),
  })),
  'google-pricing-html': set((html, { prov, snapshotId }) => {
    const { rows, skipped } = parseGooglePricingPage(html, prov)
    return {
      entities: normalizePrices(rows, snapshotId),
      note: skipped.length ? `${skipped.length} sections/tables skipped` : undefined,
    }
  }),
  'openai-ashby': set((text, { prov, snapshotId }) => ({
    entities: normalizeJobs(parseOpenaiAshby(text, prov).rows, snapshotId),
  })),
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
  'edgar-fts': {
    sides: [],
    removals: 'append-only',
    parse: (text, { prov, snapshotId, whitelist }) => ({
      entities: normalizeFilings(parseEdgarFts(text, whitelist, prov).rows, snapshotId),
    }),
    alerts: s1FloorAlerts,
  },
  'edgar-submissions-spcx': {
    sides: [],
    removals: 'append-only',
    parse: (text, { prov, snapshotId, whitelist }) => ({
      entities: normalizeFilings(parseEdgarSubmissionsSpcx(text, whitelist, prov).rows, snapshotId),
    }),
    alerts: s1FloorAlerts,
  },
}

/**
 * The one deterministic significance rule (boundary table, judge row): a
 * NEW S-1/424B4 filing on a whitelisted CIK always alerts, no model in the
 * loop. Only 'added' changes qualify — a baseline records no changes, so the
 * historical S-1s in a filer's recent window never fire on first sight.
 *
 * Grounding: every value in the headline and explanation is read back out of
 * the change row's after_json, re-validated as a FilingRow.
 */
export function s1FloorAlerts(changes: readonly ChangeRow[]): AlertRow[] {
  const alerts: AlertRow[] = []
  for (const change of changes) {
    if (change.change_type !== 'added' || change.entity_type !== 'filing' || !change.after_json) {
      continue
    }
    const filing = FilingRow.parse({
      ...(JSON.parse(change.after_json) as Record<string, unknown>),
      source_url: change.source_url,
      fetched_at: change.fetched_at,
    })
    if (filing.whitelist_cik === null || !isS1FloorForm(filing.form)) continue

    const filer = filing.display_names[0] ?? `CIK ${filing.whitelist_cik}`
    alerts.push(
      AlertRow.parse({
        id: contentHash({ rule: 's1-floor', change_id: change.id }),
        severity: 'critical',
        headline: `${filing.form} filed by ${filer} (${filing.file_date})`,
        explanation:
          `Accession ${filing.accession_no}: form ${filing.form} filed ${filing.file_date} by ` +
          `whitelisted CIK ${filing.whitelist_cik} (${filing.display_names.join(', ')}). ` +
          'An S-1/424B4 on a whitelisted filer always alerts — the s1-floor rule, no model in the loop.',
        change_ids: JSON.stringify([change.id]),
        rule: 's1-floor',
        created_at: change.detected_at,
        source_url: change.source_url,
        fetched_at: change.fetched_at,
      }),
    )
  }
  return alerts
}
