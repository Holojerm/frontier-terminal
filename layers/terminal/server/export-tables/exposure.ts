// XBRL facts public filers report, and the exposure series built on them. Part of EXPORT_TABLES (utils/terminal-export.ts), which fixes the order.

import { lt } from 'drizzle-orm'
import { filedBefore } from '../utils/terminal-exposure'
import * as tables from '#server/db/schema'
import { CIK, exposureView, plainTable, type ExportTable } from '../utils/terminal-export-views'

export const EXPOSURE_TABLES = {
  filed_facts: plainTable(
    'filed_facts',
    'Every XBRL fact the exposure series read from Microsoft, Alphabet, Amazon, Meta, and Oracle: capex, finance leases, backlog, and what Microsoft and Amazon tag on OpenAI and Anthropic. One row per fact per filing, so a restated value keeps the row it replaced. Rows are never edited.',
    tables.filedFacts,
    {
      id: {
        type: 'text',
        key: true,
        meaning: 'SHA-256 (hex) of ticker, concept, dims, start, end, and accession_no.',
      },
      ticker: { type: 'text', meaning: 'The filer: MSFT, GOOGL, AMZN, META, or ORCL.' },
      cik: CIK,
      concept: {
        type: 'text',
        meaning:
          'The XBRL concept with its prefix, e.g. us-gaap:PaymentsToAcquirePropertyPlantAndEquipment.',
      },
      dims: {
        type: 'text',
        meaning:
          'The context’s dimensions as axis=member pairs, sorted and joined with “;”. A typed member’s value stands in for the member. Empty for a fact with no dimension.',
      },
      start: {
        type: 'date',
        nullable: true,
        meaning: 'The period’s first day. Null for a balance, which is at end.',
      },
      end: { type: 'date', meaning: 'The period’s last day, or the balance date.' },
      value: {
        type: 'number',
        unit: 'the row’s unit column',
        meaning: 'The value as tagged, signed as the filer tagged it.',
      },
      unit: {
        type: 'text',
        meaning: 'USD, shares, pure (a ratio, 0.24 is 24%), or the measure as written.',
      },
      form: { type: 'text', meaning: 'The filing’s form: 10-Q, 10-K, or an amendment.' },
      filed: { type: 'date', meaning: 'The filing date EDGAR gives the accession.' },
      accession_no: { type: 'text', meaning: 'The filing’s EDGAR accession number.' },
      basis: {
        type: 'text',
        meaning:
          'companyfacts (EDGAR’s company facts, every fact with no dimension) or instance (the filing’s own XBRL instance, for a fact with dimensions).',
      },
      raw_key: {
        type: 'text',
        meaning: 'Key of the document the fact was read from in this site’s object store (R2).',
      },
      first_seen_at: { type: 'timestamp', meaning: 'When we first read the fact, in UTC.' },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The company facts document or the instance file the fact was read from.',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When that read ran, in UTC. A filed fact is never rewritten.',
      },
    },
    [tables.filedFacts.filed, tables.filedFacts.id],
    async (_db, at) => lt(tables.filedFacts.filed, filedBefore(at)),
    undefined,
    { ticker: tables.filedFacts.ticker },
  ),
  exposure_quarters: exposureView(
    'exposure_quarters',
    'The series on /exposure, one row per series and period: quarterly capex, backlog at each period end, and the OpenAI and Anthropic lines, from 2020. Each value is the newest filing’s. A derived quarter is a year-to-date figure less the one a quarter shorter, which the less_ columns name.',
    {
      series_id: {
        type: 'text',
        key: true,
        meaning:
          'The series, e.g. msft-capex or amzn-anthropic-equity-securities-without-readily-determinable-fair-value-upward-price-adjustment-annual-amount.',
      },
      ticker: { type: 'text', meaning: 'The filer: MSFT, GOOGL, AMZN, META, or ORCL.' },
      filer: {
        type: 'text',
        meaning: 'The filer’s name. Every value is the filer’s number, never a lab’s.',
      },
      group: { type: 'text', meaning: 'capex, rpo (backlog), openai, or anthropic.' },
      label: { type: 'text', meaning: 'What the series is, in plain words.' },
      concept: { type: 'text', meaning: 'The XBRL concept the series reads.' },
      dims: {
        type: 'text',
        meaning:
          'The dimensions of the facts the series reads, as in filed_facts. Several are joined with “ | ” when the filer tagged the line on different axes over time.',
      },
      kind: {
        type: 'text',
        meaning: 'flow (a value per quarter) or balance (a value at each period end).',
      },
      unit: { type: 'text', meaning: 'USD, shares, or pure (a ratio).' },
      start: {
        type: 'date',
        nullable: true,
        meaning: 'The quarter’s first day. Null for a balance.',
      },
      end: { type: 'date', key: true, meaning: 'The quarter’s last day, or the balance date.' },
      value: {
        type: 'number',
        unit: 'the row’s unit column',
        meaning: 'The value for the quarter or at the date.',
      },
      derived: {
        type: 'boolean',
        meaning:
          'True when the quarter is a year-to-date figure less the one a quarter shorter, because the filing tags only year to date.',
      },
      less_start: {
        type: 'date',
        nullable: true,
        meaning: 'For a derived quarter, the start of the figure taken away. Null otherwise.',
      },
      less_end: {
        type: 'date',
        nullable: true,
        meaning: 'For a derived quarter, the end of the figure taken away. Null otherwise.',
      },
      less_value: {
        type: 'number',
        unit: 'the row’s unit column',
        nullable: true,
        meaning: 'For a derived quarter, the figure taken away. Null otherwise.',
      },
      less_accession_no: {
        type: 'text',
        nullable: true,
        meaning:
          'For a derived quarter, the filing the figure taken away came from. Null otherwise.',
      },
      accession_no: {
        type: 'text',
        meaning: 'The filing the value is from: the newest that reported the period.',
      },
      form: { type: 'text', meaning: 'That filing’s form.' },
      filed: { type: 'date', meaning: 'That filing’s date.' },
      filing_url: { type: 'text', meaning: 'EDGAR’s index page for that filing.' },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The company facts document or the instance file the value was read from.',
      },
      fetched_at: { type: 'timestamp', provenance: true, meaning: 'When that read ran, in UTC.' },
    },
  ),
} satisfies Record<string, ExportTable>
