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
// This file is the registry (EXPORT_TABLES) and the app's composition root for
// exports: composed in order from each layer's records in server/export-tables/;
// a new table goes in its domain's file and, for a new file, one line here. The
// parts each table is built from are in layers/core/server/utils/terminal-export-views.ts,
// the license window in terminal-export-history.ts, and the CSV and JSON
// encoding in terminal-export-format.ts.
//
// Pure functions of the Drizzle client, so layers/terminal/test/terminal-export.test.ts can
// drive them against the workerd D1 and read the bytes back.

import { LIVE_TABLES } from '#layers/core/server/export-tables/live'
import { PROBE_TABLES } from '#layers/reliability/server/export-tables/probes'
import { PRINT_TABLES } from '#layers/compute/server/export-tables/prints'
import { FILING_TABLES } from '#layers/companies/server/export-tables/filings'
import { HISTORY_TABLES } from '#layers/core/server/export-tables/history'
import { CLAIM_TABLES } from '#layers/terminal/server/export-tables/theses'
import { PRESS_TABLES } from '#layers/terminal/server/export-tables/press'
import { RECIPE_TABLES } from '#layers/terminal/server/export-tables/recipes'
import { DOWNLOAD_TABLES } from '#layers/adoption/server/export-tables/downloads'
import { GRID_LOAD_TABLES } from '#layers/compute/server/export-tables/grid-load'
import { LISTED_HIRING_TABLES } from '#layers/talent/server/export-tables/listed-hiring'
import { EXPOSURE_TABLES } from '#layers/companies/server/export-tables/exposure'
import { RUN_TABLES } from '#layers/core/server/export-tables/runs'
import { COMPANY_REFERENCE_TABLES } from '#layers/companies/server/export-tables/reference'
import { POWER_SITE_TABLES } from '#layers/compute/server/export-tables/power-sites'
import { SIGNAL_TABLES } from '#layers/terminal/server/export-tables/signals'
import type { ExportTable } from '#layers/core/server/utils/terminal-export-views'

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
  ...PRINT_TABLES,
  ...FILING_TABLES,
  ...HISTORY_TABLES,
  ...CLAIM_TABLES,
  ...PRESS_TABLES,
  ...RECIPE_TABLES,
  ...DOWNLOAD_TABLES,
  ...EXPOSURE_TABLES,
  ...RUN_TABLES,
  ...COMPANY_REFERENCE_TABLES,
  ...POWER_SITE_TABLES,
  ...SIGNAL_TABLES,
  ...GRID_LOAD_TABLES,
  ...LISTED_HIRING_TABLES,
}

export const EXPORT_TABLE_NAMES = Object.keys(EXPORT_TABLES)

/**
 * The tables read from Internet Archive copies (each axis's terminal-*-archive.ts). They
 * answer as_of by when the Archive saw the page, so an instant before our
 * first snapshot is not refused, and no paid license relabels them.
 */
export const ARCHIVED_EXPORTS: ReadonlySet<string> = new Set([
  'archived_prices',
  'archived_hiring',
  'archived_gpu_prices',
  'archived_incidents',
  'archived_rate_limits',
  'archive_captures',
])

export function exportTable(name: string): ExportTable | null {
  return Object.prototype.hasOwnProperty.call(EXPORT_TABLES, name) ? EXPORT_TABLES[name]! : null
}
