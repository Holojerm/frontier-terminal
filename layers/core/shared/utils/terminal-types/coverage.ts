import type {
  Prov,
  ProviderId,
  RunStatus,
  SourceAxis,
  SourceRights,
  SourceRole,
  Stamp,
} from './common'

export interface SnapshotStamp extends Prov {
  http_status: number | null
  bytes: number | null
}

export interface SourceRunStamp {
  started_at: string
  status: RunStatus
  detail: string | null
  scope: string
  /**
   * The url this run actually fetched. Usually the same as the newest
   * snapshot's, and the only record of it when the run produced no snapshot
   * — a 404 is fetched and stored nowhere else.
   */
  source_url: string
}

/**
 * A degraded source (server/utils/source-health.ts): its checks have failed
 * for six hours straight, or it passes now but failed three or more checks
 * in the last week. Null for a healthy source.
 */
export type SourceHealth =
  | { kind: 'failing'; since: string }
  | { kind: 'intermittent'; failures: number; window_days: number }

/** One registered source, whether or not it has ever been fetched. */
export interface SourceCoverage {
  source_id: string
  label: string
  provider: ProviderId | 'all'
  axis: SourceAxis
  role: SourceRole
  /** The audit's own words, read from sources.yaml — never paraphrased here. */
  caveat: string | null
  /**
   * The licence the source itself states, verbatim from sources.yaml. Null
   * where it states none, which is most of them — a pricing page publishes
   * facts without publishing terms, and inventing terms on its behalf would be
   * exactly the kind of claim the provenance rule exists to prevent.
   */
  license: string | null
  /**
   * The audit's reading of the source's terms and robots.txt, what is taken
   * and how often, verbatim from sources.yaml. A derived source carries the
   * entry of the registered source its template belongs to.
   */
  terms: string | null
  rights: SourceRights | null
  /** The audited URL this source is fetched from. */
  url: string
  newest_snapshot: SnapshotStamp | null
  snapshot_count: number
  last_run: SourceRunStamp | null
  health: SourceHealth | null
  /** Rows in the current entity set that came from this source. */
  entity_count: number
  /** Set for a source the store derived for itself (sources.yaml derived_sources): the template id. */
  derived_from: string | null
}

export interface TableCounts {
  snapshots: number
  entities: number
  changes: number
  alerts: number
  source_runs: number
}

export interface ExportTableInfo {
  name: string
  description: string
  columns: string[]
  /** Whole table. Windowed tables count every row, though the default download is the license window. */
  rows: number
  /** windowed: the default download is the trailing license window; whole: every row. */
  history: 'windowed' | 'whole'
}

/** A column's value type in both export formats (DATA_TYPES says what each means). */
export type DictionaryType =
  | 'text'
  | 'integer'
  | 'number'
  | 'timestamp'
  | 'date'
  | 'json'
  | 'boolean'

/** One exported column, as /export/dictionary.json documents it. */
export interface DictionaryColumn {
  name: string
  type: DictionaryType
  /** What the column holds, in one sentence. */
  meaning: string
  unit: string | null
  nullable: boolean
  /** key: part of the row's unique key. provenance: where and when the row was read. */
  role: 'key' | 'provenance' | null
  /** Present only when the table is requested with ?as_of=. */
  as_of_only: boolean
}

export interface DictionaryTable {
  name: string
  description: string
  csv: string
  json: string
  /** The columns that identify a row, in order. */
  key: string[]
  /** One row per what. */
  grain: string
  /** How often rows are added or rewritten. */
  cadence: string
  /** event: the column dating what the row describes (null for a bare observation). knowledge: when the row first existed for us. */
  time: { event: string | null; knowledge: string }
  as_of: { mode: 'cut' | 'rebuilt' | 'refused'; note: string }
  /**
   * How the license window cuts the default download: windowed tables serve
   * the rows `dated` on or after its first day (?history=full serves all),
   * whole tables every row. `start` says where the history begins.
   */
  history: {
    mode: 'windowed' | 'whole'
    dated: string[]
    full: string | null
    note: string
    start: string
  }
  /** The identifier columns to join on, and what each joins to. */
  joins: DictionaryJoin[]
  /** Whether a licensee can use the rows commercially, from each feeding source's sources.yaml rights. */
  licensing: {
    commercial: 'yes' | 'restricted' | 'upstream' | 'no' | 'mixed'
    note: string
    ours: string[]
    /** Sources whose site terms restrict automated reading: licensable as our compilation, disclosed. */
    restricted: string[]
    upstream: { id: string; license: string | null }[]
    not_cleared: string[]
  }
  columns: DictionaryColumn[]
}

export interface DictionaryJoin {
  column: string
  /** `table.column`, or `your security master` for an identifier to match outside the site. */
  to: string
}

/** One source's commercial-use answer, from its sources.yaml rights. */
export interface SourceLicensing {
  id: string
  /** The sources.yaml block it's in. */
  group:
    | 'sources'
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
  rights: SourceRights | null
  /** The licence the source states, verbatim, or null. */
  license: string | null
  commercial: string
}

export interface DataDictionary {
  /** The export schema's version (layers/core/server/utils/data-schema.ts). */
  schema_version: string
  types: Record<DictionaryType, string>
  provenance: string
  /** The license split, and the license column a full-history download adds. */
  license: string
  /** What event time and knowledge time mean. */
  time: string
  /** How to join the tables to a security master. */
  joining: string
  tables: DictionaryTable[]
  /** Every source sources.yaml rates, with its commercial-use answer. */
  sources: SourceLicensing[]
  /** Every schema release, newest first. */
  changelog: SchemaChangelogEntry[]
}

/** One release of the export schema: what it added, removed, or renamed, per table. */
export interface SchemaChangelogEntry {
  version: string
  /** UTC day the release reached /export. */
  date: string
  summary: string
  tables: {
    name: string
    added: string[]
    removed: string[]
    renamed: { from: string; to: string }[]
    note: string | null
  }[]
}

export interface CutSource {
  id: string
  verdict: string
  reason: string
}

/** One thesis recipe (layers/terminal/server/theses/recipes/): how its last run ended and what it has stored. */
export interface TrackRecordSource {
  id: string
  url: string | null
  terms: string | null
  rights: SourceRights | null
  caveat: string | null
}

export interface RecipeCoverage {
  recipe_id: string
  company: string
  description: string
  /** The URL the last run fetched; the recipe's own URL before any run. */
  url: string
  last_run: {
    status: 'ok' | 'unchanged' | 'failed' | 'skipped'
    started_at: string
    detail: string | null
  } | null
  observations: number
  /** Newest stored observation's fetch. */
  newest: Prov | null
  /** The audit's words from sources.yaml recipe_sources; null only for a recipe with no entry, which a test forbids. */
  caveat: string | null
  terms: string | null
  rights: SourceRights | null
}

export interface CoverageData extends Stamp {
  sources: SourceCoverage[]
  /** Deliberate cuts from sources.yaml — what is NOT tracked, and why. */
  cuts: CutSource[]
  /** The thesis recipes, which store outside the lab tables. */
  recipes: RecipeCoverage[]
  /** Sources the track record matches per alert (GDELT), with their audit entry. */
  track_record: TrackRecordSource[]
  totals: TableCounts
  exports: ExportTableInfo[]
  /** Newest fetch across every source, failed reads included. */
  latest_fetched_at: string | null
  /** Oldest fetch on record: where every table's history starts. */
  first_fetched_at: string | null
}
