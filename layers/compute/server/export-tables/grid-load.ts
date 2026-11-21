// Grid load where the lab sites are: EIA-930 days and ERCOT's large-load figures. Part of EXPORT_TABLES (server/registries/export-tables.ts), which fixes the order.

import * as tables from '#server/db/schema'
import {
  byColumn,
  plainTable,
  type ExportTable,
} from '#layers/core/server/utils/terminal-export-views'

export const GRID_LOAD_TABLES = {
  grid_load_days: plainTable(
    'grid_load_days',
    'Daily demand for each balancing authority that holds a lab’s data-center site, from the U.S. Energy Information Administration’s EIA-930 data (public domain; Source: U.S. Energy Information Administration): its API v2 from 2019, its six-month Grid Monitor files for 2018. One row per authority and local day: the sum of the hourly "Demand (MW) (Adjusted)" values, EIA’s cleaned copy of what the authority reported, over the hours that carry one. A load reading, not a measure of how busy any data center is. /api/grid-load derives the monthly and weekly averages and their change on a year before from these rows.',
    tables.gridLoadDays,
    {
      ba: {
        type: 'text',
        key: true,
        meaning:
          'EIA-930’s code for the balancing authority: ERCO, PJM, MISO, NYIS, AZPS, SOCO, TVA, EPE.',
      },
      date: {
        type: 'date',
        key: true,
        meaning: 'The authority’s local date (EIA’s Data Date).',
      },
      mwh: {
        type: 'number',
        unit: 'megawatt-hours',
        meaning: 'The day’s hourly demand values summed: each hour’s megawatts held for one hour.',
      },
      hours: {
        type: 'number',
        meaning:
          'How many of the day’s hours carry a value (24 on most days, 23 or 25 across a clock change). mwh / hours is the day’s average load in megawatts.',
      },
      raw_key: {
        type: 'text',
        meaning:
          'Key in this site’s object store (R2) of the API response, whole, or of the file’s header and every line for the tracked authorities, verbatim.',
      },
      first_seen_at: { type: 'timestamp', meaning: 'When the day was first read, in UTC.' },
      source_url: {
        type: 'text',
        provenance: true,
        meaning:
          'The EIA API v2 request (a key is needed to repeat it, and none is in the URL) or the EIA-930 six-month file read.',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When the file the current value came from was read, in UTC.',
      },
    },
    [tables.gridLoadDays.ba, tables.gridLoadDays.date],
    'EIA revises its files, and a day is rewritten in place when a later read differs; the value it replaced is not kept.',
    undefined,
    { ba: tables.gridLoadDays.ba },
  ),
  ercot_large_load_facts: plainTable(
    'ercot_large_load_facts',
    'ERCOT’s own count of large loads (mostly data centers and crypto mines) on its grid, read from its Monthly Operational Overview and its ERCOT Monthly PDFs. One row per figure a report states, with the sentence it is read from. Each report is a vintage: a month a later report restates has a row per report. approved_to_energize_mw and observed_peak_mw come from one sentence, where observed is the sum of each approved load’s own peak in the month, not their combined draw at one time.',
    tables.ercotLargeLoadFacts,
    {
      id: {
        type: 'text',
        key: true,
        meaning: 'SHA-256 (hex) of the report URL, the metric and the period.',
      },
      report_url: { type: 'text', meaning: 'The ERCOT PDF the figure is read from.' },
      metric: {
        type: 'text',
        meaning:
          'approved_to_energize_mw (large load ERCOT has approved to energize), observed_peak_mw (the sum of each approved load’s own monthly peak), observed_energized_mw (all-time observed energized large load), approved_not_operational_mw (approved, not yet observed operating), or queue_mw (the large-load interconnection queue).',
      },
      period: {
        type: 'text',
        meaning:
          'The month the figure is for, YYYY-MM: the month the sentence names, else the report’s month.',
      },
      value: {
        type: 'number',
        unit: 'megawatts',
        meaning:
          'The figure, in megawatts (a figure ERCOT gives in gigawatts is multiplied by 1,000).',
      },
      qualifier: {
        type: 'text',
        nullable: true,
        meaning:
          'more than or roughly, where the sentence words the figure so. Null for an exact figure.',
      },
      horizon: {
        type: 'text',
        nullable: true,
        meaning: 'The year a queue figure runs to (“by 2033”). Null where the sentence gives none.',
      },
      quote: {
        type: 'text',
        meaning: 'The sentence, as the PDF’s text reads with its spacing collapsed.',
      },
      posted: { type: 'date', meaning: 'The day ERCOT posted the report (its file path).' },
      raw_key: { type: 'text', meaning: 'Key of the PDF in this site’s object store (R2).' },
      source_url: { type: 'text', provenance: true, meaning: 'The ERCOT PDF.' },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When the PDF was read, in UTC.',
      },
    },
    [tables.ercotLargeLoadFacts.id],
    byColumn(tables.ercotLargeLoadFacts.fetched_at),
    undefined,
    { metric: tables.ercotLargeLoadFacts.metric },
  ),
} satisfies Record<string, ExportTable>
