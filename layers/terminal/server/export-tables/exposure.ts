// XBRL facts public filers report, the capex guidance their earnings releases print, and the
// exposure series and dependency graph built on the facts. Part of EXPORT_TABLES
// (utils/terminal-export.ts), which fixes the order.

import { lt } from 'drizzle-orm'
import { buildSeries } from '../exposure/series'
import { dependencyEdges } from '../utils/terminal-dependencies'
import { filedBefore, filedFactsAt } from '../utils/terminal-exposure'
import { PointInTimeError } from '../utils/terminal-asof'
import * as tables from '#server/db/schema'
import type { PipelineDb } from '../pipeline/store'
import {
  CIK,
  exposureView,
  plainTable,
  type ColumnDocs,
  type ExportTable,
  type Row,
} from '../utils/terminal-export-views'

const FILER = { type: 'text', meaning: 'The filer: MSFT, GOOGL, AMZN, META, or ORCL.' } as const

const DEPENDENCY_DOCS = {
  edge_id: {
    type: 'text',
    key: true,
    meaning:
      'The line: <from_node>><to_node>:<kind>, as /api/dependencies gives it. With series_id it identifies the row.',
  },
  from_node: {
    type: 'text',
    meaning:
      'For buys, the customer. For funds, the investor. A lab id (openai, anthropic), a filer’s ticker, or crux-ai.',
  },
  to_node: {
    type: 'text',
    meaning: 'For buys, the supplier. For funds, the lab. A lab id, a filer’s ticker, or crux-ai.',
  },
  kind: {
    type: 'text',
    meaning: 'buys (the customer owes the supplier) or funds (the investor backs the lab).',
  },
  reporter: {
    type: 'text',
    meaning:
      'The filer whose XBRL states every figure on the line: MSFT, GOOGL, AMZN, META, or ORCL.',
  },
  weight: {
    type: 'boolean',
    meaning:
      'True for the one figure on the line that sets its width on the graph: the highest-ranked positive dollar figure.',
  },
  series_id: {
    type: 'text',
    key: true,
    meaning: 'The exposure_quarters series the figure is the newest point of.',
  },
  label: { type: 'text', meaning: 'What the series is, in plain words.' },
  short: {
    type: 'text',
    meaning: 'The few words the graph labels the figure with (backlog, stake, …).',
  },
  value: {
    type: 'number',
    unit: 'the row’s unit column',
    meaning: 'The figure as the filer tagged it.',
  },
  unit: { type: 'text', meaning: 'USD, shares, or pure (a ratio, 0.24 is 24%).' },
  start: {
    type: 'date',
    nullable: true,
    meaning: 'The period’s first day. Null for a balance.',
  },
  end: { type: 'date', meaning: 'The period’s last day, or the balance date.' },
  months: {
    type: 'integer',
    unit: 'months',
    nullable: true,
    meaning: 'A flow’s length. Null for a balance.',
  },
  derived: {
    type: 'boolean',
    meaning:
      'True when the quarter is a year-to-date figure less the one a quarter shorter, as in exposure_quarters.',
  },
  note: {
    type: 'text',
    nullable: true,
    meaning: 'What a reader should know about the series, where it has a note.',
  },
  accession_no: { type: 'text', meaning: 'The filing the figure is from.' },
  form: { type: 'text', meaning: 'That filing’s form.' },
  filed: { type: 'date', meaning: 'That filing’s date.' },
  filing_url: { type: 'text', meaning: 'EDGAR’s index page for that filing.' },
  source_url: {
    type: 'text',
    provenance: true,
    meaning: 'The company facts document or the instance file the figure was read from.',
  },
  fetched_at: { type: 'timestamp', provenance: true, meaning: 'When that read ran, in UTC.' },
} satisfies ColumnDocs

/** The dependency graph's lines, one row per figure, built from filed_facts (filed before T's day, as of T). */
async function dependencyRows(db: PipelineDb, at: string | null): Promise<Row[]> {
  const { edges } = dependencyEdges(buildSeries(await filedFactsAt(db, at)))
  return edges.flatMap((e) =>
    e.facts.map((f) => ({
      edge_id: e.id,
      from_node: e.from,
      to_node: e.to,
      kind: e.kind,
      reporter: e.reporter,
      weight: f === e.weight,
      series_id: f.series_id,
      label: f.label,
      short: f.short,
      value: f.value,
      unit: f.unit,
      start: f.start,
      end: f.end,
      months: f.months,
      derived: f.derived,
      note: f.note,
      accession_no: f.accession_no,
      form: f.form,
      filed: f.filed,
      filing_url: f.filing_url,
      source_url: f.source_url,
      fetched_at: f.fetched_at,
    })),
  )
}

function dependencyView(at: string | null): ExportTable {
  return {
    name: 'dependency_edges',
    description:
      'The lines of the dependency graph on /dependencies: each figure one public company’s XBRL puts on a named counterparty, a lab or a venture, placed on a buys or a funds line between them. One row per figure, the newest filed point of its exposure_quarters series. Deals reported only in the press aren’t here. Chip and compute suppliers are in supplier_passages.',
    columns: Object.keys(DEPENDENCY_DOCS),
    docs: DEPENDENCY_DOCS,
    async page(db, after, limit) {
      const rows = await dependencyRows(db, at)
      const from =
        after === null
          ? 0
          : rows.findIndex((r) => r.edge_id === after.edge_id && r.series_id === after.series_id) +
            1
      return rows.slice(from, from + limit)
    },
    count: async (db) => (await dependencyRows(db, at)).length,
    at: (_db, instant) =>
      at === null
        ? Promise.resolve(dependencyView(instant))
        : Promise.reject(new PointInTimeError('already a point-in-time view')),
    asOfRefusal: null,
    pointInTime: 'cut',
  }
}

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
  filed_guidance: plainTable(
    'filed_guidance',
    'The capex guidance in each earnings release Microsoft, Alphabet, Amazon, Meta, and Oracle furnish (exhibit 99.1 of an 8-K with item 2.02), one row per fiscal year a release gives a figure or range for, with the release’s own sentence. Guidance given only on the call isn’t here, since we don’t read transcripts. A release that prints none has no row. Rows are never edited.',
    tables.filedGuidance,
    {
      id: {
        type: 'text',
        key: true,
        meaning: 'SHA-256 (hex) of ticker, accession_no, and fiscal_year.',
      },
      ticker: FILER,
      cik: CIK,
      accession_no: { type: 'text', meaning: 'The 8-K’s EDGAR accession number.' },
      filed: { type: 'date', meaning: 'The 8-K’s filing date, as EDGAR gives it.' },
      fiscal_year: {
        type: 'integer',
        meaning:
          'The year the sentence names. For a fiscal year that isn’t the calendar year, the year it ends in.',
      },
      low: {
        type: 'number',
        unit: 'USD',
        meaning: 'The low end of the range the sentence states, or its single figure.',
      },
      high: {
        type: 'number',
        unit: 'USD',
        meaning: 'The high end of the range. Equal to low for a single figure.',
      },
      sentence: {
        type: 'text',
        meaning:
          'The release’s sentence the figure was read from, with entities decoded and whitespace collapsed.',
      },
      raw_key: {
        type: 'text',
        meaning: 'Key of the release in this site’s object store (R2).',
      },
      first_seen_at: { type: 'timestamp', meaning: 'When we first read the release, in UTC.' },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The release (the exhibit itself) the sentence was read from.',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When that read ran, in UTC. A release is never read again once read.',
      },
    },
    [tables.filedGuidance.filed, tables.filedGuidance.id],
    async (_db, at) => lt(tables.filedGuidance.filed, filedBefore(at)),
    undefined,
    { ticker: tables.filedGuidance.ticker },
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
  dependency_edges: dependencyView(null),
} satisfies Record<string, ExportTable>
