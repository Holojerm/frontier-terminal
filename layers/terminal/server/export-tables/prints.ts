// The hardware layer's monthly prints, every vintage. Part of EXPORT_TABLES (utils/terminal-export.ts), which fixes the order.

import * as tables from '#server/db/schema'
import { byColumn, plainTable, SOURCE_NAME, type ExportTable } from '../utils/terminal-export-views'

const t = tables.hardwarePrints

export const PRINT_TABLES = {
  hardware_prints: plainTable(
    'hardware_prints',
    'Monthly prints from the hardware layer around the labs: the revenue of TSMC, the Taiwan server builders (Hon Hai, Quanta, Wistron, Wiwynn, Gigabyte), Accton and Delta, as each source first gave it. A release that restates a month we hold at a different figure adds a row with the next vintage, so no figure is ever overwritten and a backtest can take each month as it stood at any time. Chains of vintages are per source. Rows with basis backfill were read after the release, from an archive of releases; their published_at, where set, is the release time.',
    tables.hardwarePrints,
    {
      id: {
        type: 'text',
        key: true,
        meaning: 'series|entity|period|window|source_id|vintage.',
      },
      series: {
        type: 'text',
        meaning: 'tw_revenue (a Taiwan company’s consolidated monthly revenue).',
      },
      entity: {
        type: 'text',
        meaning:
          'The company: tsmc, hon-hai, quanta, wistron, wiwynn, gigabyte, accton or delta. Not yet in entity_identifiers; join on ticker. TSMC’s US listing is TSM.',
      },
      ticker: {
        type: 'text',
        nullable: true,
        meaning: 'The company’s Taiwan Stock Exchange listing (2330.TW).',
      },
      period: { type: 'text', meaning: 'The month the figure is for, YYYY-MM.' },
      window: {
        type: 'text',
        meaning: 'month for a calendar month; d10 and d20 for the first 10 or 20 days of it.',
      },
      value: {
        type: 'number',
        meaning:
          'The figure in currency units, at the source’s precision: NT$ thousand from the exchange feed and Accton’s page, NT$ million from TSMC’s 6-K.',
      },
      currency: { type: 'text', meaning: 'TWD or USD.' },
      yoy_pct: {
        type: 'number',
        unit: 'percent',
        nullable: true,
        meaning:
          'The change on the same month a year earlier, as the release states it. Null on a restated month.',
      },
      observed_as: {
        type: 'text',
        meaning:
          'print (the month the release is for), prior_month or year_ago (a month the release restates).',
      },
      vintage: {
        type: 'number',
        meaning:
          '1 for the first figure this source gave for the month, 2 on for each different figure after it.',
      },
      first_seen_at: {
        type: 'timestamp',
        meaning: 'When our read first held this figure, in UTC.',
      },
      published_at: {
        type: 'timestamp',
        nullable: true,
        meaning:
          'When the source says the release was made public, in UTC: the 6-K’s EDGAR acceptance time. Null where the source states none.',
      },
      due_on: {
        type: 'date',
        nullable: true,
        meaning:
          'The statutory deadline for the release: the 10th of the next month in Taiwan (Securities and Exchange Act art. 36).',
      },
      basis: {
        type: 'text',
        meaning:
          'live (our hourly read found it) or backfill (read from the source’s archive after the release, so first_seen_at is not the release time).',
      },
      source_id: SOURCE_NAME,
      raw_key: {
        type: 'text',
        nullable: true,
        meaning: 'The R2 object holding the bytes the figure was read from.',
      },
      source_url: { type: 'text', provenance: true, meaning: 'The feed, page or 6-K read.' },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When that read ran, in UTC. Equal to first_seen_at: a row is never re-read.',
      },
    },
    [t.first_seen_at, t.id],
    byColumn(t.first_seen_at),
    undefined,
    { entity: t.entity },
  ),
} satisfies Record<string, ExportTable>
