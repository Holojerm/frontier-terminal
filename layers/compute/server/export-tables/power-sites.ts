// Who supplies power to the lab sites, as read from filings and pages. Part of
// EXPORT_TABLES (server/registries/export-tables.ts), which fixes the order.

import * as tables from '#server/db/schema'
import { plainTable, type ExportTable } from '#layers/core/server/utils/terminal-export-views'

export const POWER_SITE_TABLES = {
  power_site_ties: plainTable(
    'power_site_ties',
    'Who supplies power to the data-center sites Epoch AI ties to a lab: one row per company a public page ties to a site (the utility, a generator, an equipment maker, the site host), and one for the grid where a page names it. Each is read from a filing, a regulator’s page, or the company’s own, never press coverage. The first rows were read by hand. When a new SEC filing names a site, a model reads it, and a row is kept only where the quote, the company, the site and any megawatt figure are in the filing word for word (basis). A row from a filing ends when the filer’s next filing of the same periodic form no longer has its quote, and stays in the table with ended_at set. A row from any other page is re-read weekly. The sites, their power, and their users are Epoch’s, in recipe_observations.',
    tables.powerSiteTies,
    {
      id: {
        type: 'text',
        key: true,
        meaning:
          'SHA-256 (hex) of site, role, company_name, source_url, and quote, as first read. A row later restamped to a newer filing keeps its id.',
      },
      site: {
        type: 'text',
        meaning:
          'Epoch’s name for the site, exactly: the key of its epoch-data-centers rows in recipe_observations.',
      },
      role: {
        type: 'text',
        meaning:
          'utility, generation (a power plant or developer), equipment (turbines, fuel cells), host (the site’s owner or operator), or grid (the grid operator the site draws from).',
      },
      company_name: {
        type: 'text',
        meaning: 'The company as the page names it, or the grid operator on a grid row.',
      },
      parent: {
        type: 'text',
        nullable: true,
        meaning: 'The listed parent when the company is a subsidiary. Null otherwise.',
      },
      ticker: {
        type: 'text',
        nullable: true,
        meaning:
          'The ticker of the company or its listed parent. Null when neither is listed, and on a grid row.',
      },
      unlisted: {
        type: 'text',
        nullable: true,
        meaning:
          'Why there is no ticker: municipal, federal, private, or not matched to a listing (a company a model read that the table has not listed before and is not the filer). Null when there is one, and on a grid row.',
      },
      mw: {
        type: 'number',
        unit: 'megawatts',
        nullable: true,
        meaning:
          'A megawatt figure the page itself ties to this site and company. Null where the page gives none.',
      },
      mw_meaning: {
        type: 'text',
        nullable: true,
        meaning: 'What mw measures, in the page’s terms. Null with no mw.',
      },
      source_title: {
        type: 'text',
        nullable: true,
        meaning: 'The page’s title. Null on a grid row.',
      },
      publisher: {
        type: 'text',
        nullable: true,
        meaning: 'Who published the page. Null on a grid row.',
      },
      published: {
        type: 'date',
        nullable: true,
        meaning:
          'The day the page was published, or the filing date. Null where it gives none, and on a grid row.',
      },
      quote: {
        type: 'text',
        meaning: 'The passage the row rests on, as the page has it.',
      },
      basis: {
        type: 'text',
        meaning:
          'hand (read by a person) or judge (read by a model from a stored SEC filing that names the site, and checked by the Worker: the quote, the company, the site and any megawatt figure are in the filing verbatim).',
      },
      accession_no: {
        type: 'text',
        nullable: true,
        meaning:
          'The EDGAR accession number of the filing at source_url. Null for a page off EDGAR.',
      },
      first_seen_at: {
        type: 'timestamp',
        meaning:
          'When the row entered the table, in UTC: the hand read’s check, or the judge’s reading.',
      },
      ended_at: {
        type: 'timestamp',
        nullable: true,
        meaning:
          'When the filer’s next filing of the same periodic form was read for the site and no longer had the quote, in UTC. Null while the row stands.',
      },
      ended_by: {
        type: 'text',
        nullable: true,
        meaning: 'The accession number of that filing. Null while the row stands.',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The page the passage is on.',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning:
          'When the page was last fetched and the quote found on it, in UTC. For a filing, when it or a later filing repeating the quote was read. For any other page, its weekly re-read.',
      },
    },
    [tables.powerSiteTies.id],
    'rows are restamped to newer filings, re-dated by the weekly re-read and ended in place, so the table’s past isn’t kept.',
  ),
} satisfies Record<string, ExportTable>
