// The license window: which rows of each export table the default (recent)
// export serves, how a full-history export labels each row, and the license
// headers. The dates themselves are in shared/utils/license.ts.

import { and, gte } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'

import * as tables from '#server/db/schema'
import {
  DATA_LICENSE,
  HISTORY_LICENSE,
  HISTORY_PARAM,
  LICENSE_SPLIT_EFFECTIVE,
  LICENSE_WINDOW_DAYS,
  licenseWindowStart,
  rowLicense,
  type LicenseRef,
} from '#shared/utils/license'
import { PointInTimeError, parseAsOfQuery } from './terminal-asof'
import { project, type ExportTable, type Row } from './terminal-export-views'
import { ARCHIVED_EXPORTS } from './terminal-export'

/** A table of current rows or a lookup: every export serves all of it. */
export interface WholeRule {
  kind: 'whole'
  /** Why it isn't cut by age, for the data dictionary. */
  why: string
  /** When a row first appeared here, for labeling a rebuild older than the window. Null where as_of is refused. */
  published: string | null
}

/** A table that grows over time: the default export is the rows dated inside the window. */
export interface WindowedRule {
  kind: 'windowed'
  /** The row's own date: the first of these columns that isn't null. */
  dated: readonly [string, ...string[]]
  /** What that date is, in the dictionary's words. */
  basis: string
  /** When the row first appeared here (rowLicense). */
  published: string
  /** `dated[0]` as a column, so the window is a SQL condition; without it rows are filtered as they stream. */
  column?: SQLiteColumn
}

export type HistoryRule = WholeRule | WindowedRule

const whole = (why: string, published: string | null = 'first_seen_at'): WholeRule => ({
  kind: 'whole',
  why,
  published,
})

const windowed = (
  dated: readonly [string, ...string[]],
  basis: string,
  published: string,
  column?: SQLiteColumn,
): WindowedRule => ({ kind: 'windowed', dated, basis, published, column })

/**
 * Every export table's license-window rule. Current-state and reference
 * tables stay whole; a log, an observation series, or a list of dated events
 * is windowed on its natural date. layers/terminal/test/terminal-dictionary.test.ts
 * fails when a table has no rule or a rule names a column the table lacks.
 */
export const EXPORT_HISTORY: Readonly<Record<string, HistoryRule>> = {
  snapshots: windowed(
    ['fetched_at'],
    'fetched_at, when we read the page',
    'fetched_at',
    tables.snapshots.fetched_at,
  ),
  prices_latest: whole('it holds one current row per SKU.'),
  jobs_open: whole('it holds the roles listed now.'),
  incidents: windowed(
    ['started_at', 'first_seen_at'],
    'started_at, when the incident began (first_seen_at where the feed gives no start)',
    'first_seen_at',
  ),
  disclosures: windowed(
    ['listed_on', 'first_seen_at'],
    'listed_on, the date the index prints (first_seen_at where it prints none)',
    'first_seen_at',
  ),
  disclosure_timelines: windowed(
    ['disclosed_on', 'discovered_on', 'first_seen_at'],
    'disclosed_on, else discovered_on, else first_seen_at',
    'first_seen_at',
  ),
  filers: whole('it’s a lookup of one CIK per lab.'),
  revenue_facts: windowed(['end'], 'end, the period end', 'first_seen_at'),
  prospectus_statements: windowed(['filed'], 'filed, the filing date', 'first_seen_at'),
  prospectus_commitments: windowed(['filed'], 'filed, the filing date', 'first_seen_at'),
  prospectus_concentration: windowed(['filed'], 'filed, the filing date', 'first_seen_at'),
  prospectus_shares: windowed(['filed'], 'filed, the filing date', 'first_seen_at'),
  prospectus_risk_factors: windowed(['filed'], 'filed, the filing date', 'first_seen_at'),
  changes: windowed(
    ['detected_at'],
    'detected_at, when we saw the change',
    'detected_at',
    tables.changes.detected_at,
  ),
  archived_prices: windowed(
    ['captured_at'],
    'captured_at, when the Internet Archive saw the page',
    'fetched_at',
    tables.archivedPrices.captured_at,
  ),
  archived_hiring: windowed(
    ['captured_at'],
    'captured_at, when the Internet Archive saw the board',
    'fetched_at',
    tables.archivedHiring.captured_at,
  ),
  archive_captures: windowed(
    ['captured_at'],
    'captured_at, when the Internet Archive saw the page',
    'fetched_at',
    tables.archiveCaptures.captured_at,
  ),
  alerts: windowed(
    ['created_at'],
    'created_at, when the alert was written',
    'created_at',
    tables.alerts.created_at,
  ),
  claim_readings: windowed(
    ['date'],
    'date, the data date',
    'computed_at',
    tables.claimReadings.date,
  ),
  claim_verdicts: windowed(
    ['detected_at'],
    'detected_at, when we saw the change it rates',
    'judged_at',
    tables.claimVerdicts.detected_at,
  ),
  track_record_candidates: windowed(
    ['found_at'],
    'found_at, when we found the article',
    'found_at',
    tables.trackRecordCandidates.found_at,
  ),
  track_record_verdicts: windowed(
    ['judged_at'],
    'judged_at, when the judge rated it',
    'judged_at',
    tables.trackRecordVerdicts.judged_at,
  ),
  reported_articles: windowed(
    ['found_at'],
    'found_at, when we found the article',
    'found_at',
    tables.reportedArticles.found_at,
  ),
  reported_figures: windowed(
    ['judged_at'],
    'judged_at, when the judge labeled it',
    'judged_at',
    tables.reportedFigures.judged_at,
  ),
  recipe_observations: windowed(
    ['date'],
    'date, the date the value is for',
    'first_seen_at',
    tables.recipeObservations.date,
  ),
  filed_facts: windowed(['end'], 'end, the period end', 'first_seen_at', tables.filedFacts.end),
  exposure_quarters: windowed(['end'], 'end, the period end', 'fetched_at'),
  source_runs: windowed(
    ['started_at'],
    'started_at, when the check ran',
    'started_at',
    tables.sourceRuns.started_at,
  ),
  entity_securities: whole('it’s a hand-checked lookup of labs to securities.', null),
  entity_identifiers: whole('it’s a lookup of one row per company.', null),
}

/** The license window's rule for a registered table. */
export function historyRule(name: string): HistoryRule {
  const rule = EXPORT_HISTORY[name]
  if (!rule) throw new Error(`no license-window rule for export ${name}`)
  return rule
}

/** A row's own date under its table's rule, or null when every dated column is empty. */
export function rowDate(rule: WindowedRule, row: Row): string | null {
  for (const column of rule.dated) {
    const value = row[column]
    if (value !== null && value !== undefined && value !== '') return String(value)
  }
  return null
}

/** Whether `row` is dated on or after `from`. A row with no date at all is kept, since nothing says it is old. */
export function inWindow(rule: WindowedRule, row: Row, from: string): boolean {
  const dated = rowDate(rule, row)
  return dated === null || dated >= from
}

/**
 * The table cut to rows dated on or after `from` (licenseWindowStart): what an
 * export serves without `?history=full`.
 */
export function windowOf(table: ExportTable, rule: HistoryRule, from: string): ExportTable {
  if (rule.kind === 'whole') return table
  const { column } = rule
  const keep = (row: Row) => inWindow(rule, row, from)
  return {
    ...table,
    async page(db, after, limit, where) {
      if (column) return table.page(db, after, limit, and(where, gte(column, from)))
      // Not a column of its own (a payload field, a built row): filter each
      // page, resuming after the last row read, until one is full.
      const out: Row[] = []
      let cursor = after
      for (;;) {
        const rows = await table.page(db, cursor, limit, where)
        for (const row of rows) {
          if (!keep(row)) continue
          out.push(row)
          if (out.length === limit) return out
        }
        if (rows.length < limit) return out
        cursor = rows.at(-1)!
      }
    },
    count: () => Promise.reject(new Error('not counted for a window')),
  }
}

/** The column a full-history export adds, just before source_url. */
export const LICENSE_COLUMN = 'license'

/** The columns of `table` with LICENSE_COLUMN before source_url. */
export function licensedColumns(columns: readonly string[]): string[] {
  const at = columns.indexOf('source_url')
  return [...columns.slice(0, at), LICENSE_COLUMN, ...columns.slice(at)]
}

/** Every row of `table`, each labeled with the SPDX id `licenseOf` gives it. */
export function licensedOf(table: ExportTable, licenseOf: (row: Row) => string): ExportTable {
  const columns = licensedColumns(table.columns)
  return {
    ...table,
    columns,
    async page(db, after, limit, where) {
      const rows = await table.page(db, after, limit, where)
      return rows.map((row) => project({ ...row, [LICENSE_COLUMN]: licenseOf(row) }, columns))
    },
  }
}

export type HistoryQuery = 'recent' | 'full'

/** `as_of` and `history` (recent, the default, or full), for getValidatedQuery. */
export function parseExportQuery(query: unknown): { as_of?: string; history?: HistoryQuery } {
  const history = (query as Record<string, unknown> | null)?.[HISTORY_PARAM]
  if (history !== undefined && history !== 'recent' && history !== 'full') {
    throw new PointInTimeError(`${HISTORY_PARAM} must be recent (the default) or full`)
  }
  return { ...parseAsOfQuery(query), ...(history === undefined ? {} : { history }) }
}

export interface LicenseWindow {
  table: ExportTable
  /** The first day of the window (licenseWindowStart). */
  from: string
  /** The default export of a table that grows, cut to the window. */
  windowed: boolean
  /** Rows older than the window may be in it, each labeled in LICENSE_COLUMN. */
  split: boolean
  /** What those older rows are labeled: HISTORY_LICENSE, or PAID_LICENSE for a licensee's key. */
  older: LicenseRef
}

/**
 * Apply the license window to `table` (already rebuilt at `as_of`, if asked):
 *
 * - a windowed table serves the rows dated inside the window, or every row
 *   with its license when `history=full`. An `as_of` before the window has no
 *   rows inside it, so without `history=full` it is a PointInTimeError.
 * - a whole table is served whole. Rebuilt at an `as_of` before the window it
 *   is older data, and its rows are labeled the same way.
 */
export function licenseWindow(
  name: string,
  table: ExportTable,
  query: { as_of?: string; history?: HistoryQuery },
  from: string = licenseWindowStart(),
  requested: LicenseRef = HISTORY_LICENSE,
): LicenseWindow {
  const rule = historyRule(name)
  // A licensee's key never relabels these: they were read from the Internet
  // Archive, whose terms grant access for scholarship and research
  // (sources.yaml › archive_sources › wayback-pricing, rights not-cleared).
  const older = ARCHIVED_EXPORTS.has(name) ? HISTORY_LICENSE : requested
  const label = (dated: (row: Row) => string | null) =>
    licensedOf(table, (row) => {
      const published = rule.published === null ? null : row[rule.published]
      return rowLicense(dated(row), typeof published === 'string' ? published : null, from, older)
        .id
    })

  const { as_of } = query
  if (rule.kind === 'whole') {
    if (as_of === undefined || as_of >= from)
      return { table, from, windowed: false, split: false, older }
    return { table: label(() => as_of), from, windowed: false, split: true, older }
  }
  if (query.history === 'full') {
    return { table: label((row) => rowDate(rule, row)), from, windowed: false, split: true, older }
  }
  if (as_of !== undefined && as_of < from) {
    throw new PointInTimeError(
      `as_of ${as_of} is before ${from}, the start of the trailing ${LICENSE_WINDOW_DAYS} days, which is all /export/${name} serves by default. Add ${HISTORY_PARAM}=full for the full history, licensed ${HISTORY_LICENSE.short} for our compilation (see /license).`,
    )
  }
  return { table: windowOf(table, rule, from), from, windowed: true, split: false, older }
}

/**
 * The license as HTTP headers, so it reaches a client that never opens the
 * body: a `Link rel=license` (RFC 4946) to each license that applies, and the
 * window the rows were cut to.
 */
export function licenseHeaders(window: LicenseWindow): Record<string, string> {
  if (window.split) {
    return {
      Link: `<${window.older.url}>; rel="license", <${DATA_LICENSE.url}>; rel="license", </license>; rel="terms-of-service"`,
      'X-License': `${window.older.id} for rows dated before ${window.from} that we first published on or after ${LICENSE_SPLIT_EFFECTIVE}, ${DATA_LICENSE.id} for the rest. The ${LICENSE_COLUMN} column labels each row.`,
    }
  }
  return {
    Link: `<${DATA_LICENSE.url}>; rel="license", </license>; rel="terms-of-service"`,
    'X-License': DATA_LICENSE.id,
    ...(window.windowed
      ? {
          'X-History': `Rows dated on or after ${window.from}, the trailing ${LICENSE_WINDOW_DAYS} days. Add ?${HISTORY_PARAM}=full for every row.`,
        }
      : {}),
  }
}

/** Rows in a sample file. */
export const SAMPLE_ROWS = 50

// A table that grows over time is sampled from its newest rows: its first rows
// are the day the pipeline started, which shows a reader none of what it has
// logged since. Each span is tried in turn until one holds a full sample, so
// a busy log reads a few days and a quiet one a few months.
const SAMPLE_SPANS_DAYS = [3, 30, LICENSE_WINDOW_DAYS]
const SAMPLE_PAGE = 500

async function newestRows(
  db: Parameters<ExportTable['page']>[0],
  table: ExportTable,
  where: Parameters<ExportTable['page']>[3],
): Promise<Row[]> {
  let tail: Row[] = []
  let cursor: Row | null = null
  for (;;) {
    const rows = await table.page(db, cursor, SAMPLE_PAGE, where)
    tail = [...tail, ...rows].slice(-SAMPLE_ROWS)
    if (rows.length < SAMPLE_PAGE) return tail
    cursor = rows.at(-1)!
  }
}

/**
 * The same table cut to SAMPLE_ROWS rows, for /export/sample/<table>.<format>:
 * the newest rows of a table windowed on a date column, in export order, and
 * the first rows of any other table. A windowed table with too few recent rows
 * (or read as of a past date) falls back to its first rows.
 */
export function sampleOf(table: ExportTable, now: Date = new Date()): ExportTable {
  const rule = EXPORT_HISTORY[table.name]
  const column = rule?.kind === 'windowed' ? rule.column : undefined
  return {
    ...table,
    filters: undefined,
    async page(db, after, _limit, where) {
      if (after !== null) return []
      if (column) {
        for (const days of SAMPLE_SPANS_DAYS) {
          const from = new Date(now.getTime() - days * 86_400_000).toISOString()
          const rows = await newestRows(db, table, and(where, gte(column, from)))
          if (rows.length === SAMPLE_ROWS) return rows
        }
      }
      return table.page(db, null, SAMPLE_ROWS, where)
    },
    async count(db) {
      return Math.min(SAMPLE_ROWS, await table.count(db))
    },
    async at(db, at) {
      return sampleOf(await table.at(db, at))
    },
  }
}
