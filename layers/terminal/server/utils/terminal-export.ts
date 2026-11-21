// Bulk exports of the store: every table, as CSV or JSON, streamed in pages
// so a 100k-row changes table never has to fit in Worker memory at once.
//
// The entity views (prices_latest, jobs_open, incidents, revenue_facts) flatten the JSON payload
// into columns, because a CSV with a JSON blob in one cell is not a
// spreadsheet anyone can sort. Provenance columns are always present and
// always last: source_url and fetched_at on every table except source_runs,
// which has no fetched_at by design (a failed run fetched nothing) and
// carries started_at instead.
//
// The CSV defuses cells a spreadsheet would execute (see defuseFormula); the
// JSON is verbatim, because nothing executes a JSON string.
//
// The data license is split by age (shared/utils/license.ts), so a bulk export
// of a table that grows over time serves the trailing window by default and
// every row behind `?history=full`, each row then labeled in a `license`
// column. EXPORT_HISTORY classifies every table and names the date it is cut on.
//
// `?as_of=` (ExportTable.at) serves a table as the store held it at that instant:
// an append-only table by the column that says when each row was written,
// read as a range on the index its keyset already pages; an entity view
// rebuilt from the change log (terminal-asof.ts); and a table rewritten in
// place with no log refused with a 400, since its past is gone.
//
// This file is the registry (EXPORT_TABLES), composed in order from the
// per-domain records in server/export-tables/; a new table goes in its
// domain's file. The parts each table is built from are in terminal-export-views.ts, the license window in
// terminal-export-history.ts, and the CSV and JSON encoding in
// terminal-export-format.ts.
//
// Pure functions of the Drizzle client, so layers/terminal/test/terminal-export.test.ts can
// drive them against the workerd D1 and read the bytes back.

import { LIVE_TABLES } from '../export-tables/live'
import { PROBE_TABLES } from '../export-tables/probes'
import { FILING_TABLES } from '../export-tables/filings'
import { HISTORY_TABLES } from '../export-tables/history'
import { CLAIM_TABLES } from '../export-tables/theses'
import { PRESS_TABLES } from '../export-tables/press'
import { RECIPE_TABLES } from '../export-tables/recipes'
import { EXPOSURE_TABLES } from '../export-tables/exposure'
import { REFERENCE_TABLES } from '../export-tables/reference'
import type { ExportTable } from './terminal-export-views'

/**
 * Tables that were exported and no longer are, with the reason a request for
 * one is told (410, not 404: the URL existed). See docs/source-audit.md.
 */
export const WITHDRAWN_EXPORTS: Readonly<Record<string, string>> = {
  rankings_daily:
    'OpenRouter licenses its rankings CC BY 4.0 but says the dataset "is not intended to be re-served as a competing free API", so we no longer offer the raw per-model daily rows as a download. Per-lab shares and top models are still at /rankings and /api/rankings. You can get the rows from openrouter.ai/api/v1/datasets/rankings-daily with an OpenRouter key.',
}

export const EXPORT_TABLES: Readonly<Record<string, ExportTable>> = {
  ...LIVE_TABLES,
  ...PROBE_TABLES,
  ...FILING_TABLES,
  ...HISTORY_TABLES,
  ...CLAIM_TABLES,
  ...PRESS_TABLES,
  ...RECIPE_TABLES,
  ...EXPOSURE_TABLES,
  ...REFERENCE_TABLES,
}

export const EXPORT_TABLE_NAMES = Object.keys(EXPORT_TABLES)

/**
 * The tables read from Internet Archive copies (terminal-archive.ts). They
 * answer as_of by when the Archive saw the page, so an instant before our
 * first snapshot is not refused, and no paid license relabels them.
 */
export const ARCHIVED_EXPORTS: ReadonlySet<string> = new Set([
  'archived_prices',
  'archived_hiring',
  'archived_gpu_prices',
  'archived_incidents',
  'archive_captures',
])

export function exportTable(name: string): ExportTable | null {
  return Object.prototype.hasOwnProperty.call(EXPORT_TABLES, name) ? EXPORT_TABLES[name]! : null
}
