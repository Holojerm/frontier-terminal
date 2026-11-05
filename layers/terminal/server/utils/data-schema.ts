// The export schema's version and its history: what /export, the bulk feed,
// and every /api envelope carry as `schema_version`, and what /data and
// CHANGELOG-data.md list as the schema changelog.
//
// The promise to licensees: adding a table or a column is a minor version.
// Removing or renaming one is a major version, announced BREAKING_NOTICE_DAYS
// ahead. Changing what a column holds without renaming it is a minor version
// with a note. A release that changes no column is a patch.
//
// SCHEMA_BASELINE is every table's columns at 1.0.0, and each later release
// lists what it added and removed. layers/terminal/test/terminal-dictionary.test.ts
// replays the releases over the baseline and fails when the result isn't what
// /export serves today, or when a release's version bump is smaller than its
// changes need. So a column can't move without a release here, and a release
// can't be filed under the wrong kind of bump.

import type { SchemaChangelogEntry } from '../../shared/utils/terminal-types'

export interface TableChange {
  added?: readonly string[]
  removed?: readonly string[]
  /** Old name to new name: a removal and an addition, so always major. */
  renamed?: Readonly<Record<string, string>>
  note?: string
}

export interface SchemaRelease {
  version: string
  /** UTC day the release reached /export. */
  date: string
  summary: string
  /** Per table, what changed. A new table lists all its columns as added. */
  tables?: Readonly<Record<string, TableChange>>
}

/** Every exported table's default columns at 1.0.0, in export order. */
export const SCHEMA_BASELINE: Readonly<Record<string, readonly string[]>> = {
  snapshots: [
    'id',
    'source_id',
    'content_hash',
    'raw_key',
    'http_status',
    'bytes',
    'source_url',
    'fetched_at',
  ],
  prices_latest: [
    'entity_key',
    'source_id',
    'provider',
    'model_slug',
    'tier',
    'context_window',
    'input_per_mtok',
    'cached_input_per_mtok',
    'output_per_mtok',
    'currency',
    'effective_from',
    'effective_until',
    'notes',
    'content_hash',
    'snapshot_id',
    'first_seen_at',
    'source_url',
    'fetched_at',
  ],
  jobs_open: [
    'entity_key',
    'source_id',
    'provider',
    'job_id',
    'title',
    'department',
    'team',
    'location',
    'employment_type',
    'published_at',
    'updated_at',
    'company_name',
    'content_hash',
    'snapshot_id',
    'first_seen_at',
    'source_url',
    'fetched_at',
  ],
  incidents: [
    'entity_key',
    'source_id',
    'provider',
    'incident_id',
    'title',
    'impact',
    'status',
    'started_at',
    'resolved_at',
    'components',
    'incident_url',
    'content_hash',
    'snapshot_id',
    'first_seen_at',
    'source_url',
    'fetched_at',
  ],
  disclosures: [
    'entity_key',
    'source_id',
    'provider',
    'kind',
    'entry_id',
    'title',
    'summary',
    'model',
    'observed_during',
    'listed_on',
    'entry_url',
    'content_hash',
    'snapshot_id',
    'first_seen_at',
    'source_url',
    'fetched_at',
  ],
  disclosure_timelines: [
    'entity_key',
    'source_id',
    'provider',
    'entry_id',
    'title',
    'lines',
    'discovered_on',
    'disclosed_on',
    'content_hash',
    'snapshot_id',
    'first_seen_at',
    'source_url',
    'fetched_at',
  ],
  filers: [
    'entity_key',
    'source_id',
    'provider',
    'cik',
    'name',
    'resolved_form',
    'resolved_accession',
    'resolved_file_date',
    'content_hash',
    'snapshot_id',
    'first_seen_at',
    'source_url',
    'fetched_at',
  ],
  revenue_facts: [
    'entity_key',
    'source_id',
    'provider',
    'cik',
    'entity_name',
    'taxonomy',
    'tag',
    'unit',
    'start',
    'end',
    'val',
    'accession_no',
    'fy',
    'fp',
    'form',
    'filed',
    'frame',
    'whitelist_cik',
    'content_hash',
    'snapshot_id',
    'first_seen_at',
    'source_url',
    'fetched_at',
  ],
  prospectus_statements: [
    'entity_key',
    'source_id',
    'provider',
    'part',
    'cik',
    'entity_name',
    'accession_no',
    'form',
    'filed',
    'start',
    'end',
    'unaudited',
    'units',
    'line_key',
    'label',
    'val',
    'unit',
    'first_seen_at',
    'source_url',
    'fetched_at',
  ],
  prospectus_commitments: [
    'entity_key',
    'source_id',
    'provider',
    'part',
    'cik',
    'entity_name',
    'accession_no',
    'form',
    'filed',
    'schedule',
    'as_of',
    'audited',
    'approximate',
    'line',
    'bucket',
    'val',
    'statement',
    'first_seen_at',
    'source_url',
    'fetched_at',
  ],
  prospectus_concentration: [
    'entity_key',
    'source_id',
    'provider',
    'part',
    'cik',
    'entity_name',
    'accession_no',
    'form',
    'filed',
    'basis',
    'customer',
    'start',
    'end',
    'unaudited',
    'pct',
    'first_seen_at',
    'source_url',
    'fetched_at',
  ],
  prospectus_shares: [
    'entity_key',
    'source_id',
    'provider',
    'part',
    'cik',
    'entity_name',
    'accession_no',
    'form',
    'filed',
    'measure',
    'as_of',
    'label',
    'shares',
    'with_option',
    'first_seen_at',
    'source_url',
    'fetched_at',
  ],
  prospectus_risk_factors: [
    'entity_key',
    'source_id',
    'provider',
    'part',
    'cik',
    'entity_name',
    'accession_no',
    'form',
    'filed',
    'section',
    'heading',
    'change',
    'previous',
    'first_seen_at',
    'source_url',
    'fetched_at',
  ],
  changes: [
    'id',
    'entity_key',
    'entity_type',
    'provider',
    'change_type',
    'before_hash',
    'after_hash',
    'before_json',
    'after_json',
    'detected_at',
    'source_url',
    'fetched_at',
  ],
  alerts: [
    'id',
    'severity',
    'headline',
    'explanation',
    'change_ids',
    'rule',
    'created_at',
    'source_url',
    'fetched_at',
  ],
  claim_readings: [
    'thesis_id',
    'claim_id',
    'date',
    'value',
    'detail',
    'computed_at',
    'source_url',
    'fetched_at',
  ],
  claim_verdicts: [
    'id',
    'thesis_id',
    'claim_id',
    'subject',
    'change_id',
    'provider',
    'verdict',
    'rationale',
    'facts',
    'detected_at',
    'judged_at',
    'source_url',
    'fetched_at',
  ],
  track_record_candidates: [
    'id',
    'alert_id',
    'kind',
    'title',
    'snippet',
    'outlet',
    'url',
    'published_at',
    'search_id',
    'found_at',
    'source_url',
    'fetched_at',
  ],
  track_record_verdicts: [
    'id',
    'candidate_id',
    'alert_id',
    'same_event',
    'rationale',
    'judged_at',
    'source_url',
    'fetched_at',
  ],
  recipe_observations: [
    'id',
    'recipe_id',
    'company',
    'key',
    'date',
    'value',
    'payload',
    'raw_key',
    'first_seen_at',
    'source_url',
    'fetched_at',
  ],
  filed_facts: [
    'id',
    'ticker',
    'cik',
    'concept',
    'dims',
    'start',
    'end',
    'value',
    'unit',
    'form',
    'filed',
    'accession_no',
    'basis',
    'raw_key',
    'first_seen_at',
    'source_url',
    'fetched_at',
  ],
  exposure_quarters: [
    'series_id',
    'ticker',
    'filer',
    'group',
    'label',
    'concept',
    'dims',
    'kind',
    'unit',
    'start',
    'end',
    'value',
    'derived',
    'less_start',
    'less_end',
    'less_value',
    'less_accession_no',
    'accession_no',
    'form',
    'filed',
    'filing_url',
    'source_url',
    'fetched_at',
  ],
  source_runs: [
    'id',
    'scope',
    'source_id',
    'started_at',
    'status',
    'detail',
    'snapshot_id',
    'added',
    'removed',
    'modified',
    'source_url',
  ],
  entity_securities: [
    'entity',
    'entity_name',
    'entity_kind',
    'relationship',
    'issuer',
    'cik',
    'symbol',
    'exchange',
    'listing_status',
    'note',
    'source_url',
    'checked_on',
  ],
}

export const SCHEMA_RELEASES: readonly SchemaRelease[] = [
  {
    version: '1.0.0',
    date: '2026-11-04',
    summary:
      'First versioned schema. Every export, bulk file, and API response states its schema_version from here on. A full-history export adds a license column before source_url, and a rebuilt export (?as_of=) adds as_of_verified. Neither changes the default columns.',
  },
  {
    version: '1.1.0',
    date: '2026-11-04',
    summary:
      'New: alert webhooks for licensees. Each POST carries schema_version, the alert with the columns of the alerts table plus permalink, source_urls and its cited rows of the changes table, and the license for your key. No table columns changed.',
  },
  {
    version: '1.2.0',
    date: '2026-11-04',
    summary:
      'Two tables for the price history from before we watched the labs, read from the Internet Archive’s copies of each lab’s own pricing page: archived_prices (one row per SKU per copy) and archive_captures (every copy considered, read or skipped with the reason).',
    tables: {
      archived_prices: {
        added: [
          'id',
          'capture_id',
          'entity_key',
          'provider',
          'content_hash',
          'payload',
          'captured_at',
          'original_url',
          'basis',
          'source_url',
          'fetched_at',
        ],
      },
      archive_captures: {
        added: [
          'id',
          'era',
          'provider',
          'original_url',
          'captured_at',
          'status',
          'detail',
          'content_hash',
          'raw_key',
          'bytes',
          'rows',
          'source_url',
          'fetched_at',
        ],
      },
    },
  },
  {
    version: '1.3.0',
    date: '2026-11-05',
    summary:
      'New: every bulk file also as Parquet (zstd), the same rows and columns typed by the data dictionary, listed under parquet in each manifest entry. Licensees can also read the full-history files over S3 with read-only credentials. No table columns changed.',
  },
  {
    version: '1.4.0',
    date: '2026-11-05',
    summary:
      'Security-master identifiers. entity_identifiers has one row per company we name, with its CIK, LEI, ticker, MIC and FIGI, each with the URL and time we read it. Join any provider or company column to its entity_id. entity_securities gains mic, figi, and disclosed_in, the filing that discloses a parent or an investor. It also gains a row for Alphabet’s stake in Anthropic, from Anthropic’s S-1/A.',
    tables: {
      entity_identifiers: {
        added: [
          'entity_id',
          'entity_name',
          'entity_kind',
          'legal_name',
          'country',
          'listing_status',
          'cik',
          'cik_source_url',
          'cik_fetched_at',
          'lei',
          'lei_status',
          'lei_note',
          'lei_source_url',
          'lei_fetched_at',
          'ticker',
          'exchange',
          'mic',
          'figi',
          'share_class_figi',
          'figi_source_url',
          'figi_fetched_at',
          'note',
          'source_url',
          'fetched_at',
        ],
      },
      entity_securities: {
        added: ['mic', 'figi', 'disclosed_in'],
        note: 'A new investor row: anthropic to GOOGL, disclosed in Anthropic’s S-1/A.',
      },
    },
  },
]

export const SCHEMA_VERSION = SCHEMA_RELEASES.at(-1)!.version

/** Days of notice a licensee gets before a major release removes or renames a column. */
export const BREAKING_NOTICE_DAYS = 90

/** The response header a CSV or a JSON array export carries its version in. */
export const SCHEMA_VERSION_HEADER = 'X-Schema-Version'

export type Bump = 'major' | 'minor' | 'patch'

function parse(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) throw new Error(`not a semver version: ${version}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** The kind of bump from `from` to `to`, or null when `to` isn't the next version of any kind. */
export function bumpOf(from: string, to: string): Bump | null {
  const [a, b, c] = parse(from)
  const [x, y, z] = parse(to)
  if (x === a + 1 && y === 0 && z === 0) return 'major'
  if (x === a && y === b + 1 && z === 0) return 'minor'
  if (x === a && y === b && z === c + 1) return 'patch'
  return null
}

const RANK: Readonly<Record<Bump, number>> = { patch: 0, minor: 1, major: 2 }

/** The smallest bump a release's changes allow. */
export function bumpNeeded(release: SchemaRelease): Bump {
  let need: Bump = 'patch'
  for (const change of Object.values(release.tables ?? {})) {
    if (change.removed?.length || Object.keys(change.renamed ?? {}).length) return 'major'
    if (change.added?.length || change.note) need = 'minor'
  }
  return need
}

export function bumpCovers(made: Bump, needed: Bump): boolean {
  return RANK[made] >= RANK[needed]
}

/**
 * Every table's columns after `releases`, from the baseline. An added column
 * goes before source_url when the table has one (provenance stays last), else
 * at the end. A table whose columns are all removed is dropped.
 */
export function replaySchema(
  releases: readonly SchemaRelease[] = SCHEMA_RELEASES,
): Record<string, string[]> {
  const out: Record<string, string[]> = Object.fromEntries(
    Object.entries(SCHEMA_BASELINE).map(([name, columns]) => [name, [...columns]]),
  )
  for (const release of releases.slice(1)) {
    for (const [name, change] of Object.entries(release.tables ?? {})) {
      // A new table lists its columns in export order, provenance included.
      const fresh = !(name in out)
      let columns = out[name] ?? []
      for (const [from, to] of Object.entries(change.renamed ?? {})) {
        columns = columns.map((c) => (c === from ? to : c))
      }
      columns = columns.filter((c) => !change.removed?.includes(c))
      for (const added of change.added ?? []) {
        const at = fresh ? -1 : columns.indexOf('source_url')
        if (at === -1) columns.push(added)
        else columns.splice(at, 0, added)
      }
      if (columns.length) out[name] = columns
      else delete out[name]
    }
  }
  return out
}

/** The changelog as the dictionary serves it: newest first. */
export function schemaChangelog(): SchemaChangelogEntry[] {
  return [...SCHEMA_RELEASES].reverse().map((release) => ({
    version: release.version,
    date: release.date,
    summary: release.summary,
    tables: Object.entries(release.tables ?? {}).map(([name, change]) => ({
      name,
      added: [...(change.added ?? [])],
      removed: [...(change.removed ?? [])],
      renamed: Object.entries(change.renamed ?? {}).map(([from, to]) => ({ from, to })),
      note: change.note ?? null,
    })),
  }))
}
