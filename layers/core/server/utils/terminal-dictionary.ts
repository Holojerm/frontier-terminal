// The data dictionary: every exported column's type, meaning, unit, nullability
// and role, for /data, /export/dictionary.json and /export/dictionary.csv.
//
// Columns, their meanings, descriptions and the as_of mode come from
// EXPORT_TABLES, where each column is declared with its entry, so none can go
// undocumented. Only what the export code cannot say about itself is written
// in each layer's server/dictionary.ts: how a cut table answers as_of, and each
// table's grain, cadence and licensing. server/registries/dictionary.ts composes
// them and calls buildDataDictionary.

import { EXPORT_TABLES } from '#server/registries/export-tables'

/** Served at /export/dictionary.json and .csv; no export table may take the name. */
export const DICTIONARY_NAME = 'dictionary'

export const DATA_TYPES: Readonly<Record<DictionaryType, string>> = {
  text: 'A string.',
  integer: 'A whole number.',
  number: 'A decimal number, as the source states it. We never round it.',
  timestamp:
    'An ISO-8601 timestamp with its zone (Z or ±hh:mm). Stamps we write are UTC. Stamps read from a vendor keep the vendor’s offset.',
  date: 'A calendar date, YYYY-MM-DD.',
  json: 'Structured data. Nested in the JSON export and JSON text in a CSV cell, except where the meaning says the column is JSON text in both.',
  boolean: 'true or false, as the words true and false in a CSV cell.',
}

export const PROVENANCE_NOTE =
  'Every row ends with source_url, the URL it was read from, and fetched_at, when that fetch ran. source_runs has started_at instead, since a failed run fetched nothing. entity_securities has checked_on, since its rows are hand-checked. entity_identifiers also gives each identifier its own source URL and fetch time. In a CSV an empty cell is null.'

export const LICENSE_NOTE =
  `Rows dated in the last ${LICENSE_WINDOW_DAYS} days are ${DATA_LICENSE.short}. ` +
  `A table that grows over time downloads only those rows by default. Add ?${HISTORY_PARAM}=full for every row. ` +
  `That download adds a ${LICENSE_COLUMN} column before source_url: ${HISTORY_LICENSE.id} for a row dated before the window that we first published on or after ${LICENSE_SPLIT_EFFECTIVE}, ${DATA_LICENSE.id} for the rest. ` +
  'Tables of current rows and lookups download whole. Rebuilt at an as_of before the window, they get the same column. ' +
  'Upstream data keeps its own license.'

const REBUILT_NOTE =
  'Rebuilt from the current rows and the change log. For each key we take the content the first change after as_of replaced, else the current row if it was written by then. The view gains an as_of_verified column. False marks a key whose state the log does not confirm.'

// ---- each table's entry ------------------------------------------------------

/** Which sources a table's rows come from, for its licensing answer. */
export type DictionaryFeed =
  /** Records of our own checks (what we fetched and when), whatever the source. */
  | 'own'
  /** Every include source in sources.yaml. */
  | 'all'
  | 'recipes'
  | 'track_record'
  | 'archive'
  | 'filed_facts'
  | 'identifiers'
  | 'power_sites'
  | 'grid_load'
  | 'prints'
  | 'calls'
  | 'listed_hiring'
  | { axes: readonly SourceAxis[] }
  /** Named sources, by id. */
  | { ids: readonly string[] }

/** What a table's export cannot say about itself. Each layer writes its own tables' entries. */
export interface DictionaryEntry {
  /** One row per what. */
  grain: string
  cadence: string
  /** The column dating the thing the row describes, as the source dates it. Null when the row is only an observation. */
  event: string | null
  /** The column dating when we (or the public, for a filing) first had the row. */
  knowledge: string
  /** How a `cut` table is cut at as_of. Rebuilt and refused tables say so from the export. */
  cut?: string
  /** Where the history starts, live and archived. */
  start: string
  joins: readonly DictionaryJoin[]
  feeds: readonly DictionaryFeed[]
  /** Which columns come from which source, where a table mixes them by column. */
  licenseNote?: string
}

const ENTITY_ID = 'entity_identifiers.entity_id'

/** Words and joins several layers' entries share. */
export const DICTIONARY_COMMON = {
  live: 'From our first check of each source.',
  survey: 'Every 6 hours, with the full check of every source.',
  entityId: ENTITY_ID,
  byProvider: { column: 'provider', to: ENTITY_ID } satisfies DictionaryJoin,
} as const

/** What the app composes the dictionary from (server/registries/dictionary.ts). */
export interface DictionaryParts {
  /** Every export table's entry, by table name. */
  entries: Readonly<Record<string, DictionaryEntry>>
  /** How the tables join, served as `joining`. */
  joining: string
  /** The CIK whitelist in sources.yaml, which the filed-fact sources are read against. */
  cikWhitelist: (sourcesYaml: string) => ReadonlyMap<string, string | null>
}

export const TIME_NOTE =
  'Event time is when the thing happened, as the source dates it. Knowledge time is when the row first existed for us (or, for a filing, when it was filed). ?as_of= cuts on knowledge time.'

// ---- commercial use, from sources.yaml rights -----------------------------------

const OURS_TERMS = `The last ${LICENSE_WINDOW_DAYS} days are ${DATA_LICENSE.short} for anyone. Older rows are ${HISTORY_LICENSE.short}, for non-commercial use only.`

const RIGHTS_ANSWER: Readonly<Record<SourceRights, string>> = {
  ours: `Yes. ${OURS_TERMS}`,
  restricted: `Yes, with a restriction we disclose. The publisher’s site terms restrict automated reading, or we couldn’t find them. Our license covers our compilation of these rows, not the saved pages. ${OURS_TERMS}`,
  upstream: 'Under its own license, which we pass on.',
  'not-cleared': 'No. It stays on the free site, and our license doesn’t cover it.',
}

interface Rated {
  id: string
  group: SourceLicensing['group']
  axis: SourceAxis | null
  rights: SourceRights | null
  license: string | null
}

/** Every source sources.yaml rates, flattened. */
function ratedSources(sourcesYaml: string, parts: DictionaryParts): Rated[] {
  const registry = readSourceRegistry(sourcesYaml)
  const flat =
    (group: SourceLicensing['group']) => (s: { id: string; rights: SourceRights | null }) => ({
      id: s.id,
      group,
      axis: null,
      rights: s.rights,
      license: null,
    })
  return [
    ...registry.sources.map((s) => ({
      id: s.source_id,
      group: 'sources' as const,
      axis: s.axis,
      rights: s.rights,
      license: s.license,
    })),
    ...registry.recipes.map((r) => flat('recipes')({ id: r.recipe_id, rights: r.rights })),
    ...registry.track_record.map(flat('track_record')),
    ...readArchiveSources(sourcesYaml).map(flat('archive')),
    ...readFiledFactSources(sourcesYaml, parts.cikWhitelist(sourcesYaml)).map(flat('filed_facts')),
    ...readIdentifierSources(sourcesYaml).map((s) => ({
      ...flat('identifiers')(s),
      license: s.license,
    })),
    ...readPowerSiteSources(sourcesYaml).map(flat('power_sites')),
    ...readGridLoadSources(sourcesYaml).map(flat('grid_load')),
    ...readPrintSources(sourcesYaml).map((s) => ({
      ...flat('prints')(s),
      license: s.license,
    })),
    ...readCallSources(sourcesYaml).map(flat('calls')),
    ...readListedHiringSources(sourcesYaml)
      .filter((s) => s.verdict.startsWith('include'))
      .map(flat('listed_hiring')),
  ]
}

function sourceAnswer(s: Rated): string {
  if (s.rights === 'upstream' && s.license) return `Under its own license: ${s.license}.`
  return s.rights ? RIGHTS_ANSWER[s.rights] : 'Not rated in sources.yaml.'
}

function feeds(f: DictionaryFeed, s: Rated): boolean {
  if (f === 'own') return false
  if (f === 'all') return s.group === 'sources'
  if (typeof f === 'string') return s.group === f
  if ('ids' in f) return f.ids.includes(s.id)
  return s.group === 'sources' && s.axis !== null && f.axes.includes(s.axis)
}

const fed = (meta: DictionaryEntry, sources: readonly Rated[]) =>
  sources.filter((s) => meta.feeds.some((f) => feeds(f, s)))

/** A stated licence without its "(where, read when)" note: "CC BY 4.0". */
const licenseName = (license: string) => license.replace(/\s*\(.*\)\s*$/, '')

/** "a", "a and b", "a, b, and c". */
const series = (parts: readonly string[]) =>
  parts.length < 3 ? parts.join(' and ') : `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`

function tableLicensing(
  meta: DictionaryEntry,
  sources: readonly Rated[],
): DictionaryTable['licensing'] {
  if (meta.feeds.includes('own')) {
    return {
      commercial: 'yes',
      note: `Yes. These are records of our own checks. ${OURS_TERMS}`,
      ours: [],
      restricted: [],
      upstream: [],
      not_cleared: [],
    }
  }
  const from = fed(meta, sources)
  const ours = from.filter((s) => s.rights === 'ours').map((s) => s.id)
  const restricted = from.filter((s) => s.rights === 'restricted').map((s) => s.id)
  const upstream = from
    .filter((s) => s.rights === 'upstream')
    .map((s) => ({ id: s.id, license: s.license }))
  const notCleared = from
    .filter((s) => s.rights === 'not-cleared' || s.rights === null)
    .map((s) => s.id)
  const lists = { ours, restricted, upstream, not_cleared: notCleared }
  const kinds = [ours, restricted, upstream, notCleared].filter((l) => l.length > 0).length
  const licenses = [
    ...new Set(upstream.flatMap((u) => (u.license ? [licenseName(u.license)] : []))),
  ]
  const upstreamTerms = licenses.length ? ` (${licenses.join('; ')})` : ''
  if (kinds === 1 && ours.length) {
    return { commercial: 'yes', note: RIGHTS_ANSWER.ours, ...lists }
  }
  if (kinds === 1 && restricted.length) {
    return { commercial: 'restricted', note: RIGHTS_ANSWER.restricted, ...lists }
  }
  if (kinds === 1 && notCleared.length) {
    return { commercial: 'no', note: RIGHTS_ANSWER['not-cleared'], ...lists }
  }
  if (kinds === 1) {
    return {
      commercial: 'upstream',
      note: `Under each source’s own license${upstreamTerms}.`,
      ...lists,
    }
  }
  const one = (n: number, singular: string, many: string) => `${n} ${n === 1 ? singular : many}`
  const parts = [
    ours.length ? one(ours.length, 'is ours to license', 'are ours to license') : null,
    restricted.length
      ? one(
          restricted.length,
          'is licensable with a terms restriction we disclose',
          'are licensable with a terms restriction we disclose',
        )
      : null,
    upstream.length
      ? `${one(upstream.length, 'passes', 'pass')} on under upstream terms${upstreamTerms}`
      : null,
    notCleared.length
      ? one(notCleared.length, 'isn’t covered by our license', 'aren’t covered by our license')
      : null,
  ].filter((p): p is string => p !== null)
  return {
    commercial: 'mixed',
    note: [
      `It depends on the source. Of the sources it reads, ${series(parts)}.`,
      restricted.length
        ? 'Our license covers what comes from sources that are ours, and our compilation of the restricted ones.'
        : 'Our license covers only what comes from sources that are ours.',
      meta.licenseNote,
    ]
      .filter(Boolean)
      .join(' '),
    ...lists,
  }
}

// ---- assembly -----------------------------------------------------------------

function asOfOf(table: ExportTable, meta: DictionaryEntry): DictionaryTable['as_of'] {
  if (table.pointInTime === 'refused') {
    const reason = table.asOfRefusal ?? ''
    return {
      mode: 'refused',
      note: `as_of answers 400 for this table. ${reason.charAt(0).toUpperCase()}${reason.slice(1)}`,
    }
  }
  if (table.pointInTime === 'rebuilt') return { mode: 'rebuilt', note: REBUILT_NOTE }
  return { mode: 'cut', note: meta.cut ?? '' }
}

function historyOf(table: ExportTable): Omit<DictionaryTable['history'], 'start'> {
  const rule = historyRule(table.name)
  if (rule.kind === 'whole') {
    return {
      mode: 'whole',
      dated: [],
      full: null,
      note: `Downloads whole, since ${rule.why}`,
    }
  }
  return {
    mode: 'windowed',
    dated: [...rule.dated],
    full: `/export/${table.name}.csv?${HISTORY_PARAM}=full`,
    note: `Downloads the last ${LICENSE_WINDOW_DAYS} days by default, dated by ${rule.basis}. Add ?${HISTORY_PARAM}=full for every row.`,
  }
}

function dictionaryTable(
  table: ExportTable,
  meta: DictionaryEntry | undefined,
  sources: readonly Rated[],
): DictionaryTable {
  if (!meta) throw new Error(`no table facts for export ${table.name}`)
  const columns = asOfColumns(table).map((name): DictionaryColumn => {
    const c = name === AS_OF_VERIFIED ? AS_OF_VERIFIED_DOC : table.docs[name]!
    return {
      name,
      type: c.type,
      meaning: c.meaning,
      unit: c.unit ?? null,
      nullable: c.nullable === true,
      role: c.key ? 'key' : c.provenance ? 'provenance' : null,
      as_of_only: !table.columns.includes(name),
    }
  })
  return {
    name: table.name,
    description: table.description,
    csv: `/export/${table.name}.csv`,
    json: `/export/${table.name}.json`,
    key: columns.filter((c) => c.role === 'key').map((c) => c.name),
    grain: meta.grain,
    cadence: meta.cadence,
    time: { event: meta.event, knowledge: meta.knowledge },
    as_of: asOfOf(table, meta),
    history: { ...historyOf(table), start: meta.start },
    joins: [...meta.joins],
    licensing: tableLicensing(meta, sources),
    columns,
  }
}

/**
 * The whole dictionary, in export order. Pure: no database, so it can never
 * be half-true. Licensing is read from `sourcesYaml`'s rights, never retyped.
 */
export function buildDataDictionary(sourcesYaml: string, parts: DictionaryParts): DataDictionary {
  const sources = ratedSources(sourcesYaml, parts)
  return {
    schema_version: SCHEMA_VERSION,
    types: { ...DATA_TYPES },
    provenance: PROVENANCE_NOTE,
    license: LICENSE_NOTE,
    time: TIME_NOTE,
    joining: parts.joining,
    tables: Object.values(EXPORT_TABLES).map((t) =>
      dictionaryTable(t, parts.entries[t.name], sources),
    ),
    sources: sources.map((s) => ({
      id: s.id,
      group: s.group,
      rights: s.rights,
      license: s.license,
      commercial: sourceAnswer(s),
    })),
    changelog: schemaChangelog(),
  }
}

export const DICTIONARY_CSV_COLUMNS = [
  'table',
  'column',
  'type',
  'unit',
  'nullable',
  'role',
  'as_of_only',
  'meaning',
  'table_as_of',
  'table_history',
] as const

/** One CSV row per table and column, in export order. */
export function dictionaryCsv(dictionary: DataDictionary): string {
  return [
    csvLine(DICTIONARY_CSV_COLUMNS),
    ...dictionary.tables.flatMap((t) =>
      t.columns.map((c) =>
        csvLine([
          t.name,
          c.name,
          c.type,
          c.unit,
          c.nullable,
          c.role,
          c.as_of_only,
          c.meaning,
          t.as_of.mode,
          t.history.mode,
        ]),
      ),
    ),
  ].join('')
}
