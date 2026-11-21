import { cikResolvedAlerts, periodicFloorAlerts, s1FloorAlerts } from './filing-floors'
import type { FilingRow } from '#layers/core/server/pipeline/contracts'
import type { Lane } from '#layers/core/server/pipeline/lanes'
import {
  normalizeDocuments,
  normalizeFilers,
  normalizeFilings,
  normalizeOfferings,
  normalizeProspectusDetails,
  normalizeRevenues,
} from './normalize'
import { COMPANYFACTS_SOURCES, parseEdgarCompanyfacts } from './parsers/sec/edgar-companyfacts'
import { FTS_SOURCES, parseEdgarFts } from './parsers/sec/edgar-fts'
import { archivesCik, parseFilingIndex, registrationTarget } from './parsers/sec/filing-index'
import { resolveFilers } from './parsers/sec/pending-filers'
import { SUBMISSIONS_SOURCES, parseEdgarSubmissions } from './parsers/sec/edgar-submissions'
import { parseProspectus } from './parsers/sec/prospectus'
import { freshFiling, freshRegistrationKey } from './prospectus-floor'
import {
  issuerProviderFor,
  revenueProviderFor,
  type RevenueFilers,
} from './parsers/sec/revenue-filers'
import { parseXbrlSegment, segmentTarget } from './parsers/sec/xbrl-segment'
import type { CikWhitelist } from './parsers/sec/whitelist'

// The SEC lanes: filings, the labs they resolve, revenue and the registration
// documents. The lane contract is core's (layers/core/server/pipeline/lanes.ts);
// server/registries/lanes.ts assembles every layer's lanes.

/**
 * Each filing's lab, read off its whitelisted CIK: a lab's own registration
 * filings (Anthropic's S-1, its amendments and 424B4) are the lab's; a
 * parent's or a supplier's stay 'other'. Before this every filing was 'other',
 * so /alerts listed Anthropic's 424B4 under Lab "Other".
 */
const filingProvider =
  (whitelist: CikWhitelist, revenueFilers: RevenueFilers) => (row: FilingRow) =>
    issuerProviderFor(row.whitelist_cik, revenueFilers, whitelist)

// The FTS tripwire lanes: filings, plus the labs those filings resolve
// (parsers/sec/pending-filers.ts). Both floors and the cik-resolved alert run.
const FTS_LANE: Lane = {
  sides: [],
  removals: 'append-only',
  reads: ['whitelist', 'pendingFilers', 'resolvedProviders', 'revenueFilers'],
  parse: (
    text,
    { prov, snapshotId, whitelist, pendingFilers, resolvedProviders, revenueFilers },
  ) => {
    const { rows } = parseEdgarFts(text, whitelist, prov)
    const filers = resolveFilers(rows, pendingFilers, resolvedProviders)
    return {
      entities: [
        ...normalizeFilings(rows, snapshotId, filingProvider(whitelist, revenueFilers)),
        ...normalizeFilers(filers, snapshotId),
      ],
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
  reads: ['whitelist', 'revenueFilers'],
  parse: (text, { prov, snapshotId, whitelist, revenueFilers }) => {
    const { rows, skipped } = parseEdgarSubmissions(text, whitelist, prov)
    return {
      entities: normalizeFilings(rows, snapshotId, filingProvider(whitelist, revenueFilers)),
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
  reads: ['whitelist', 'revenueFilers'],
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

/** The filing date in a derived segment key, `<ticker>-<filed>-<accession>`. */
const SEGMENT_FILED = /^[a-z0-9]+-(\d{4}-\d{2}-\d{2})-\d{10}-\d{2}-\d{6}$/

// A derived segment instance: one 10-Q/10-K's revenue on the filer's tagged
// segment member. A filing is never un-filed, and the prior-year comparative
// a 10-K drops is still what the earlier filing reported: append-only.
// Each filing is its own source, so its first parse is the only time its
// facts are new: a fresh filing's are news, as a registration document's are,
// and the back catalogue derived for a newly tagged filer is a baseline.
const XBRL_SEGMENT_LANE: Lane = {
  sides: [],
  removals: 'append-only',
  firstIsNews: (key, fetchedAt) => {
    const filed = key?.match(SEGMENT_FILED)?.[1]
    return filed !== undefined && freshFiling(filed, fetchedAt)
  },
  reads: ['whitelist', 'revenueFilers'],
  parse: (text, { prov, snapshotId, whitelist, revenueFilers, derivedKey }) => {
    const target = segmentTarget(derivedKey ?? '', revenueFilers, whitelist)
    const { rows, form, period_end } = parseXbrlSegment(text, target, prov)
    return {
      entities: normalizeRevenues(
        rows,
        snapshotId,
        revenueProviderFor(target.cik, revenueFilers, whitelist),
      ),
      note: `${form} for ${period_end ?? 'an unstated period'}: ${rows.length} facts on ${target.segment}`,
    }
  },
}

// A derived filing index: the one primary document of a registration filing.
const FILING_INDEX_LANE: Lane = {
  sides: [],
  removals: 'set',
  parse: (text, { prov, snapshotId, derivedKey }) => {
    const target = registrationTarget(derivedKey ?? '')
    return {
      entities: normalizeDocuments(
        parseFilingIndex(text, target, archivesCik(prov.source_url), prov),
        snapshotId,
      ),
    }
  },
}

// A derived registration document: the revenue its audited statement of
// operations prints, the cover terms, and the rest of what the document says
// (parsers/sec/prospectus.ts). A filing never changes once accepted, and an
// amendment is its own source, so the lane is append-only like the other
// revenue lanes.
const PROSPECTUS_REVENUE_LANE: Lane = {
  sides: [],
  removals: 'append-only',
  firstIsNews: freshRegistrationKey,
  parse: (text, { prov, snapshotId, derivedKey }) => {
    const target = registrationTarget(derivedKey ?? '')
    const out = parseProspectus(text, target, archivesCik(prov.source_url), prov)
    const headings = out.risk_factors?.sections.reduce((n, s) => n + s.headings.length, 0) ?? 0
    const failed = new Set(out.failed.map((f) => f.part))
    return {
      entities: [
        ...normalizeRevenues(out.revenue, snapshotId, target.provider),
        ...normalizeOfferings(out.offering ? [out.offering] : [], snapshotId),
        ...normalizeProspectusDetails(out, snapshotId),
      ],
      note:
        `${out.revenue.length} periods` +
        (out.revenue[0] ? `, row "${out.revenue[0].tag}"` : '') +
        (out.offering || failed.has('offering') ? '' : '; cover states no price range or price') +
        `; ${out.statements[0]?.lines.length ?? 0} statement lines, ${out.commitments.length} commitment schedules, ` +
        `${out.concentration.length} concentration tables, ${headings} risk-factor headings` +
        (failed.size ? `; not read: ${[...failed].join(', ')}` : ''),
      problems: out.failed.map((f) => `${f.part}: ${f.error}`),
    }
  },
}

/** Lanes for derived sources, matched by source-id prefix (server/registries/lanes.ts › laneFor). */
export const COMPANY_DERIVED_LANES: readonly { prefix: string; lane: Lane }[] = [
  { prefix: 'edgar-submissions-', lane: SUBMISSIONS_LANE },
  { prefix: 'edgar-companyfacts-', lane: COMPANYFACTS_LANE },
  { prefix: 'xbrl-segment-', lane: XBRL_SEGMENT_LANE },
  { prefix: 'filing-index-', lane: FILING_INDEX_LANE },
  { prefix: 'prospectus-revenue-', lane: PROSPECTUS_REVENUE_LANE },
]

export const COMPANY_LANES: Readonly<Record<string, Lane>> = {
  ...ftsLanes(),
  ...submissionsLanes(),
  ...companyfactsLanes(),
}
