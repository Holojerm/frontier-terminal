// The export schema's version and its history: what /export, the bulk feed,
// and every /api envelope carry as `schema_version`, and what /data and
// CHANGELOG-data.md list as the schema changelog.
//
// The promise to licensees: adding a table or a column is a minor version.
// Removing or renaming one is a major version, announced BREAKING_NOTICE_DAYS
// ahead. Changing what a column holds without renaming it is a minor version
// with a note. A release that changes no column is a patch.
//
// schema.lock.json holds the columns /export served at the last release.
// layers/terminal/test/terminal-dictionary.test.ts fails when the exported
// columns or SCHEMA_VERSION no longer match it, and `bun run schema:lock`
// (scripts/schema-lock.ts) rewrites it only when the newest release here
// says exactly what changed since (lockRefusal). So a column can't move
// without a release, and the test also fails a release filed under too small
// a bump.

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
  /**
   * Per table, what changed. A new table needs only its entry (a note); its
   * columns are read off the export. A dropped table lists them as removed.
   */
  tables?: Readonly<Record<string, TableChange>>
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
  {
    version: '1.5.0',
    date: '2026-11-05',
    summary:
      'Hiring history from before we read the labs’ job boards, from the Internet Archive’s copies of each lab’s own board: a new archived_hiring table (open roles per copy, on the whole board and per department), and an axis column on archive_captures saying which table a copy’s rows went to.',
    tables: {
      archived_hiring: {
        added: [
          'id',
          'capture_id',
          'provider',
          'scope',
          'label',
          'department_id',
          'department',
          'open_roles',
          'captured_at',
          'original_url',
          'basis',
          'source_url',
          'fetched_at',
        ],
      },
      archive_captures: {
        added: ['axis'],
        note: 'Every existing row is pricing.',
      },
    },
  },
  {
    version: '1.5.1',
    date: '2026-11-05',
    summary:
      'The Parquet bulk files are compressed with gzip instead of zstd, which failed on the largest tables. Readers pick the codec up from each file. No columns changed.',
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

/**
 * Whether a release after `version` changed `table`'s columns or what they
 * hold. An unparseable or unknown version counts as changed.
 */
export function tableChangedAfter(table: string, version: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return true
  const [a, b, c] = parse(version)
  const after = (v: string) => {
    const [x, y, z] = parse(v)
    return x !== a ? x > a : y !== b ? y > b : z > c
  }
  if (!SCHEMA_RELEASES.some((r) => r.version === version)) return true
  return SCHEMA_RELEASES.some((r) => after(r.version) && r.tables?.[table] !== undefined)
}

export function bumpCovers(made: Bump, needed: Bump): boolean {
  return RANK[made] >= RANK[needed]
}

/** schema.lock.json: every exported table's columns, in export order, at `schema_version`. */
export interface SchemaLock {
  schema_version: string
  tables: Readonly<Record<string, readonly string[]>>
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x))

/**
 * Why `columns` can't be locked over `lock`, or null when they can: unchanged
 * under the same version, or changed by exactly what the newest release, the
 * one right after the lock, says. A table whose columns only moved still
 * needs an entry (a note), since a CSV reader may go by position.
 */
export function lockRefusal(
  lock: SchemaLock,
  columns: Readonly<Record<string, readonly string[]>>,
  releases: readonly SchemaRelease[] = SCHEMA_RELEASES,
): string | null {
  const newest = releases.at(-1)!
  const names = [...new Set([...Object.keys(lock.tables), ...Object.keys(columns)])]
  const changed = names.filter(
    (name) => JSON.stringify(lock.tables[name]) !== JSON.stringify(columns[name]),
  )
  if (newest.version === lock.schema_version) {
    if (!changed.length) return null
    return `${changed.join(', ')} changed since ${lock.schema_version}. Add a release to SCHEMA_RELEASES in layers/terminal/server/utils/data-schema.ts (adding is minor, removing or renaming is major) and an entry to CHANGELOG-data.md`
  }
  if (releases.at(-2)?.version !== lock.schema_version) {
    return `schema.lock.json is at ${lock.schema_version}, but the release before ${newest.version} is ${releases.at(-2)?.version}. Lock each release as it is added`
  }
  const problems: string[] = []
  for (const name of names) {
    const before = lock.tables[name] ?? []
    const after = columns[name] ?? []
    const change = newest.tables?.[name]
    if (!changed.includes(name)) {
      if (change?.added?.length || change?.removed?.length || change?.renamed) {
        problems.push(`${name} lists column changes, but its columns didn't change`)
      }
      continue
    }
    if (!change) {
      problems.push(`${name} changed, and ${newest.version} has no entry for it`)
      continue
    }
    const renamed = Object.entries(change.renamed ?? {})
    const added = [...(change.added ?? []), ...renamed.map(([, to]) => to)]
    const removed = [...(change.removed ?? []), ...renamed.map(([from]) => from)]
    // A new table's columns are the export's; a list, if given, must agree.
    const wantAdded = after.filter((c) => !before.includes(c))
    const wantRemoved = before.filter((c) => !after.includes(c))
    const fresh = !(name in lock.tables)
    if (!(fresh && !change.added && !renamed.length) && !sameSet(added, wantAdded)) {
      problems.push(
        `${name} added ${JSON.stringify(wantAdded)}, the release says ${JSON.stringify(added)}`,
      )
    }
    if (!sameSet(removed, wantRemoved)) {
      problems.push(
        `${name} removed ${JSON.stringify(wantRemoved)}, the release says ${JSON.stringify(removed)}`,
      )
    }
  }
  return problems.length
    ? `${newest.version} doesn't match the exported columns: ${problems.join('; ')}`
    : null
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
