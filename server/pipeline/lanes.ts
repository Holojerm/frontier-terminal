import {
  AlertRow,
  FilerRow,
  FilingRow,
  contentHash,
  type ChangeRow,
  type EntityRow,
  type Provenance,
  type Provider,
} from './contracts'
import {
  normalizeFilers,
  normalizeFilings,
  normalizeIncidents,
  normalizeJobs,
  normalizePrices,
  normalizeRankings,
  normalizeRecommendations,
  normalizeRevenues,
} from './normalize'
import { parseAnthropicGreenhouse } from './parsers/hiring/anthropic-greenhouse'
import { parseOpenaiAshby } from './parsers/hiring/openai-ashby'
import { parseXaiGreenhouse } from './parsers/hiring/xai-greenhouse'
import { parseOpenRouterRankings } from './parsers/openrouter-rankings'
import { parseAnthropicModelsOverviewMd } from './parsers/pricing/anthropic-models-overview'
import { parseAnthropicPricingMd } from './parsers/pricing/anthropic-pricing'
import { parseGooglePricingPage } from './parsers/pricing/google-pricing'
import { parseOpenAiModelsMd } from './parsers/pricing/openai-models'
import { parseOpenAiModelPage } from './parsers/pricing/openai-model-page'
import { parseOpenAiPricingMd } from './parsers/pricing/openai-pricing'
import { parseXaiModelsMd } from './parsers/pricing/xai-models'
import { COMPANYFACTS_SOURCES, parseEdgarCompanyfacts } from './parsers/sec/edgar-companyfacts'
import { FTS_SOURCES, parseEdgarFts } from './parsers/sec/edgar-fts'
import { resolveFilers, type PendingFilers } from './parsers/sec/pending-filers'
import { SUBMISSIONS_SOURCES, parseEdgarSubmissions } from './parsers/sec/edgar-submissions'
import { revenueProviderFor, type RevenueFilers } from './parsers/sec/revenue-filers'
import { isPeriodicForm, isS1FloorForm } from './parsers/sec/s1-floor'
import { parseAnthropicStatus } from './parsers/status/anthropic-status'
import { parseGoogleCloudStatus } from './parsers/status/google-cloud-status'
import { parseOpenaiStatus } from './parsers/status/openai-status'
import { recommendationRows } from './recommendations'
import type { CikWhitelist } from './parsers/sec/whitelist'

// How each include source turns a fetched body into entities — the join
// between the registry (which runs parsers on committed fixtures with fixture
// provenance) and a live tick (which stamps the fetch's own provenance and
// joins against payloads fetched in the same tick).
//
// A source with no lane is fetched and snapshotted but yields no entities:
// the Greenhouse /departments feeds exist to be joined, and the OpenRouter
// model list is a cross-check that must never become a source of record
// (sources.yaml). The OpenRouter rankings feed DOES have a lane: it is the
// source of record for the demand-share axis, held out as one aggregator's
// traffic rather than the market's.

export interface ParseContext {
  prov: Provenance
  snapshotId: string
  /** Body of a side source fetched in this same tick; throws if it was not. */
  side: (sourceId: string) => string
  whitelist: CikWhitelist
  /** sources.yaml revenue_filers — which lab a company-facts filer belongs to. */
  revenueFilers: RevenueFilers
  /** sources.yaml pending_filers — the labs whose CIK an S-1 hit may resolve. */
  pendingFilers: PendingFilers
  /** Labs already resolved (or tagged in the audited file): the resolver leaves them alone. */
  resolvedProviders: ReadonlySet<Provider>
  /** For a derived source, the key it was derived for (a CIK or a slug); null for a registered one. */
  derivedKey: string | null
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

// The FTS tripwire lanes: filings, plus the labs those filings resolve
// (parsers/sec/pending-filers.ts). Both floors and the cik-resolved alert run.
const FTS_LANE: Lane = {
  sides: [],
  removals: 'append-only',
  parse: (text, { prov, snapshotId, whitelist, pendingFilers, resolvedProviders }) => {
    const { rows } = parseEdgarFts(text, whitelist, prov)
    const filers = resolveFilers(rows, pendingFilers, resolvedProviders)
    return {
      entities: [...normalizeFilings(rows, snapshotId), ...normalizeFilers(filers, snapshotId)],
      note: filers.length
        ? `resolved ${filers.map((f) => `${f.provider} -> CIK ${f.cik}`).join(', ')}`
        : undefined,
    }
  },
  alerts: (changes) => [...s1FloorAlerts(changes), ...cikResolvedAlerts(changes)],
}

function ftsLanes(): Record<string, Lane> {
  const lanes: Record<string, Lane> = {}
  for (const sourceId of Object.keys(FTS_SOURCES)) lanes[sourceId] = FTS_LANE
  return lanes
}

// One submissions lane per whitelisted CIK. A filer's recent window is a
// rolling list, so a filing scrolling out was not un-filed: append-only.
// Both floors run on every feed; a tracked form on a whitelisted CIK is an
// alert whichever feed saw it first (the FTS query is S-1-only, so the
// periodic floor only ever fires from here).
const SUBMISSIONS_LANE: Lane = {
  sides: [],
  removals: 'append-only',
  parse: (text, { prov, snapshotId, whitelist }) => {
    const { rows, skipped } = parseEdgarSubmissions(text, whitelist, prov)
    return {
      entities: normalizeFilings(rows, snapshotId),
      note: skipped ? `${skipped} filings skipped: untracked form` : undefined,
    }
  },
  alerts: (changes) => [...s1FloorAlerts(changes), ...periodicFloorAlerts(changes)],
}

function submissionsLanes(): Record<string, Lane> {
  const lanes: Record<string, Lane> = {}
  for (const sourceId of Object.keys(SUBMISSIONS_SOURCES)) lanes[sourceId] = SUBMISSIONS_LANE
  return lanes
}

// One company-facts lane per tagged revenue filer. Facts accumulate (a
// 10-K restates the prior year's quarters under a new accession), so the
// lane is append-only; the provider is the lab the filer is tagged to in
// sources.yaml, 'other' when the tag is gone — never a guess from the name.
const COMPANYFACTS_LANE: Lane = {
  sides: [],
  removals: 'append-only',
  parse: (text, { prov, snapshotId, whitelist, revenueFilers }) => {
    const { rows, tags } = parseEdgarCompanyfacts(text, whitelist, prov)
    const cik = rows[0]?.cik
    const provider = cik ? revenueProviderFor(cik, revenueFilers, whitelist) : 'other'
    return {
      entities: normalizeRevenues(rows, snapshotId, provider),
      note: tags.length ? `tags ${tags.join(', ')}` : 'no revenue tag in us-gaap facts',
    }
  },
}

function companyfactsLanes(): Record<string, Lane> {
  const lanes: Record<string, Lane> = {}
  for (const sourceId of Object.keys(COMPANYFACTS_SOURCES)) lanes[sourceId] = COMPANYFACTS_LANE
  return lanes
}

// A derived OpenAI model page: one SKU row that must be the slug it was
// derived for (the parser checks). The page IS the SKU's current state.
const OPENAI_MODEL_PAGE_LANE: Lane = {
  sides: [],
  removals: 'set',
  parse: (text, { prov, snapshotId, derivedKey }) => ({
    entities: normalizePrices(parseOpenAiModelPage(text, derivedKey, prov).rows, snapshotId),
  }),
}

/** Lanes for derived sources, by id prefix (server/pipeline/derived.ts). */
const DERIVED_LANES: readonly { prefix: string; lane: Lane }[] = [
  { prefix: 'edgar-submissions-', lane: SUBMISSIONS_LANE },
  { prefix: 'edgar-companyfacts-', lane: COMPANYFACTS_LANE },
  { prefix: 'openai-model-md-', lane: OPENAI_MODEL_PAGE_LANE },
]

/** The lane for a source id: a registered one exactly, a derived one by prefix. */
export function laneFor(sourceId: string): Lane | undefined {
  return LANES[sourceId] ?? DERIVED_LANES.find((d) => sourceId.startsWith(d.prefix))?.lane
}

/** The key a derived source id carries after its template prefix, or null. */
export function derivedKeyOf(sourceId: string): string | null {
  if (LANES[sourceId]) return null
  const d = DERIVED_LANES.find((x) => sourceId.startsWith(x.prefix))
  return d ? sourceId.slice(d.prefix.length) : null
}

// The pages the class map (server/utils/terminal-classes.ts) is transcribed
// from also carry the drift check on that map: one 'recommendation' row per
// mapped cell, beside the page's price rows (recommendations.ts).
const checked = (sourceId: string, text: string, prov: Provenance, snapshotId: string) =>
  normalizeRecommendations(recommendationRows(sourceId, text, prov), snapshotId)

export const LANES: Readonly<Record<string, Lane>> = {
  'openai-models-md': set((text, { prov, snapshotId }) => ({
    entities: [
      ...normalizePrices(parseOpenAiModelsMd(text, prov).rows, snapshotId),
      ...checked('openai-models-md', text, prov, snapshotId),
    ],
  })),
  'openai-pricing-md': set((text, { prov, snapshotId }) => ({
    entities: normalizePrices(parseOpenAiPricingMd(text, prov).rows, snapshotId),
  })),
  'anthropic-models-md': set((text, { prov, snapshotId }) => ({
    entities: [
      ...normalizePrices(parseAnthropicModelsOverviewMd(text, prov).rows, snapshotId),
      ...checked('anthropic-models-md', text, prov, snapshotId),
    ],
  })),
  'anthropic-pricing-md': set((text, { prov, snapshotId }) => ({
    entities: normalizePrices(parseAnthropicPricingMd(text, prov).rows, snapshotId),
  })),
  'xai-models-md': set((text, { prov, snapshotId }) => ({
    entities: [
      ...normalizePrices(parseXaiModelsMd(text, prov).rows, snapshotId),
      ...checked('xai-models-md', text, prov, snapshotId),
    ],
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
  ...ftsLanes(),
  ...submissionsLanes(),
  ...companyfactsLanes(),
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
    parse: (text, { prov, snapshotId }) => ({
      entities: normalizeIncidents(parseAnthropicStatus(text, prov).rows, snapshotId),
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

/** The `as_of` a rankings lane wrote into its run detail, if the detail carries one. */
export function asOfFromDetail(detail: string | null): string | null {
  return detail?.match(/as_of (\S+)/)?.[1] ?? null
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

/**
 * The second deterministic rule: a NEW 10-Q/10-K on a whitelisted CIK
 * always alerts, `notable` rather than `critical` — a periodic report is
 * scheduled news, an S-1 is not. Same grounding as s1FloorAlerts: every
 * value is read back out of the change row's after_json. An 8-K is tracked
 * but left to the judge (parsers/sec/forms.ts).
 */
export function periodicFloorAlerts(changes: readonly ChangeRow[]): AlertRow[] {
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
    if (filing.whitelist_cik === null || !isPeriodicForm(filing.form)) continue

    const filer = filing.display_names[0] ?? `CIK ${filing.whitelist_cik}`
    alerts.push(
      AlertRow.parse({
        id: contentHash({ rule: 'periodic-floor', change_id: change.id }),
        severity: 'notable',
        headline: `${filing.form} filed by ${filer} (${filing.file_date})`,
        explanation:
          `Accession ${filing.accession_no}: form ${filing.form} filed ${filing.file_date} by ` +
          `whitelisted CIK ${filing.whitelist_cik} (${filing.display_names.join(', ')}). ` +
          'A 10-Q/10-K on a whitelisted filer always alerts — the periodic-floor rule, no model in the loop. ' +
          'Where the filer is a tagged revenue filer, its XBRL revenue facts refresh on the /revenue panel at the next company-facts poll.',
        change_ids: JSON.stringify([change.id]),
        rule: 'periodic-floor',
        created_at: change.detected_at,
        source_url: change.source_url,
        fetched_at: change.fetched_at,
      }),
    )
  }
  return alerts
}

/**
 * The third deterministic rule: a lab's CIK resolved from its own S-1 hit
 * (a NEW `filer` row) always alerts, `critical` — this is the public-flip
 * moment the whole SEC axis waits for. Every value is read back out of the
 * change row's after_json, re-validated as a FilerRow.
 */
export function cikResolvedAlerts(changes: readonly ChangeRow[]): AlertRow[] {
  const alerts: AlertRow[] = []
  for (const change of changes) {
    if (change.change_type !== 'added' || change.entity_type !== 'filer' || !change.after_json) {
      continue
    }
    const filer = FilerRow.parse({
      ...(JSON.parse(change.after_json) as Record<string, unknown>),
      source_url: change.source_url,
      fetched_at: change.fetched_at,
    })
    alerts.push(
      AlertRow.parse({
        id: contentHash({ rule: 'cik-resolved', change_id: change.id }),
        severity: 'critical',
        headline: `${filer.name} filed ${filer.resolved_form} (${filer.resolved_file_date}) — CIK ${filer.cik} resolved for ${filer.provider}`,
        explanation:
          `Accession ${filer.resolved_accession}: form ${filer.resolved_form} filed ${filer.resolved_file_date} by ` +
          `${filer.name} (CIK ${filer.cik}), whose name matches the ${filer.provider} pattern in sources.yaml pending_filers. ` +
          'A registration filing by a pending lab always alerts — the cik-resolved rule, no model in the loop. ' +
          'From the next poll the CIK is whitelisted and the filer’s submissions and XBRL company-facts feeds are derived and polled; ' +
          'its reported revenue lands on /revenue as an issuer filing.',
        change_ids: JSON.stringify([change.id]),
        rule: 'cik-resolved',
        created_at: change.detected_at,
        source_url: change.source_url,
        fetched_at: change.fetched_at,
      }),
    )
  }
  return alerts
}
