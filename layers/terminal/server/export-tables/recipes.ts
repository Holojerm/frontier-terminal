// What the thesis recipes read from non-lab sources. Part of EXPORT_TABLES (server/registries/export-tables.ts), which fixes the order.

import * as tables from '#server/db/schema'
import type { PipelineDb } from '#layers/core/server/pipeline/store'
import { DOWNLOAD_SERIES, readDownloadSeries, seriesById } from '../theses/download-series'
import { PointInTimeError } from '#layers/core/server/utils/terminal-asof'
import {
  plainTable,
  type ColumnDocs,
  type ExportTable,
  type Row,
} from '#layers/core/server/utils/terminal-export-views'

const DOWNLOAD_SERIES_DOCS: ColumnDocs = {
  series_id: {
    type: 'text',
    key: true,
    meaning:
      'The series: npm-control-index, <recipe_id>-normalized, or <recipe_id>-share. Stable across releases.',
  },
  measure: { type: 'text', meaning: 'control-index, normalized, or share.' },
  registry: { type: 'text', meaning: 'npm or PyPI.' },
  company: {
    type: 'text',
    meaning:
      'The company the series is about: a lab id, cloudflare, or frontier-labs for the control index.',
  },
  recipe_id: {
    type: 'text',
    nullable: true,
    meaning: 'The recipe_observations series it divides. Null for the control index.',
  },
  date: { type: 'date', key: true, meaning: 'The UTC day.' },
  value: {
    type: 'number',
    unit: 'control-index: a multiple of the base weeks; normalized: downloads; share: 0 to 1',
    meaning:
      'control-index: the median over the control packages of each one’s downloads ÷ its own mean from 2025-06-02 to 2025-06-29. normalized: the day’s downloads ÷ the control index. share: the day’s downloads ÷ those of every core SDK in the registry’s set.',
  },
  source_url: {
    type: 'text',
    provenance: true,
    meaning:
      'The URL the divided package’s row was read from (for the index, the newest control row).',
  },
  fetched_at: { type: 'timestamp', provenance: true, meaning: 'When that row was read, in UTC.' },
}

async function downloadSeriesRows(db: PipelineDb): Promise<Row[]> {
  const series = await readDownloadSeries(db)
  return DOWNLOAD_SERIES.flatMap((def) =>
    (seriesById(series, def.id) ?? []).map((p) => ({
      series_id: def.id,
      measure: def.measure,
      registry: def.registry,
      company: def.company,
      recipe_id: def.recipe_id,
      date: p.date,
      value: p.value,
      source_url: p.source_url,
      fetched_at: p.fetched_at,
    })),
  )
}

const DOWNLOAD_SERIES_REFUSAL =
  'download_series is computed from recipe_observations, whose rows are rewritten in place, so its past isn’t kept.'

/** Built in memory from recipe_observations on each read: about ten thousand rows. */
const downloadSeriesView: ExportTable = {
  name: 'download_series',
  description:
    'Package downloads made comparable, by day: npm downloads divided by the median of five non-AI npm packages (react, typescript, express, lodash, axios), each against its own June 2025 average, so swings across all of npm cancel; and each lab’s main SDK as a share of the tracked labs’ main SDKs on npm and on PyPI. Days npm reported as an outage are left out. Computed from recipe_observations.',
  columns: Object.keys(DOWNLOAD_SERIES_DOCS),
  docs: DOWNLOAD_SERIES_DOCS,
  async page(db, after, limit) {
    const rows = await downloadSeriesRows(db)
    const from =
      after === null
        ? 0
        : rows.findIndex((r) => r.series_id === after.series_id && r.date === after.date) + 1
    return rows.slice(from, from + limit)
  },
  count: async (db) => (await downloadSeriesRows(db)).length,
  at: () => Promise.reject(new PointInTimeError(DOWNLOAD_SERIES_REFUSAL)),
  asOfRefusal: DOWNLOAD_SERIES_REFUSAL,
  pointInTime: 'refused',
}

export const RECIPE_TABLES = {
  recipe_observations: plainTable(
    'recipe_observations',
    'What each thesis recipe read from its public source (layers/terminal/server/theses/recipes/). One row per recipe, key, and date, with the value, the fields kept beside it, and the R2 key of the raw bytes.',
    tables.recipeObservations,
    {
      id: {
        type: 'text',
        key: true,
        meaning: 'SHA-256 (hex) of recipe_id, key and date: one row per recipe, key and date.',
      },
      recipe_id: {
        type: 'text',
        meaning: 'The recipe that read the value (layers/terminal/server/theses/recipes/).',
      },
      company: {
        type: 'text',
        meaning:
          'The company the recipe reads about: a lab id or a company id (cloudflare, coreweave, …).',
      },
      key: {
        type: 'text',
        meaning:
          'What the number is of: a revenue tag, a department, a package, a GPU offer, an entry.',
      },
      date: {
        type: 'date',
        meaning:
          'What the number is for: a quarter end, a day, an entry’s date, or the run’s UTC date for a source that reports a current state.',
      },
      value: {
        type: 'number',
        unit: 'the recipe’s own (USD, USD per GPU-hour, a count, megawatts, …)',
        nullable: true,
        meaning: 'The number read. Null where the entry carries none.',
      },
      payload: {
        type: 'json',
        meaning:
          'JSON text (a string in the JSON export too): the fields kept beside the value, and all a judged rationale may cite.',
      },
      raw_key: {
        type: 'text',
        meaning:
          'Key of the raw response the value was read from in this site’s object store (R2).',
      },
      first_seen_at: {
        type: 'timestamp',
        meaning: 'When this recipe, key and date was first read, in UTC.',
      },
      source_url: { type: 'text', provenance: true, meaning: 'The URL the recipe fetched.' },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning:
          'When the current value was read, in UTC. A re-read that finds the same value does not move it.',
      },
    },
    // id last: (recipe_id, key, date) is not unique, and a keyset needs a key that is.
    [
      tables.recipeObservations.recipe_id,
      tables.recipeObservations.key,
      tables.recipeObservations.date,
      tables.recipeObservations.id,
    ],
    'a recipe observation is rewritten in place when a re-read gives a different value, and the value it replaced is not kept.',
    undefined,
    { recipe_id: tables.recipeObservations.recipe_id },
  ),
  download_series: downloadSeriesView,
} satisfies Record<string, ExportTable>
