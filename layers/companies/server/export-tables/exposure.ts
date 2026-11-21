// XBRL facts public filers report, the capex guidance their earnings releases print, and the
// exposure series and dependency graph built on the facts. Part of EXPORT_TABLES
// (server/registries/export-tables.ts), which fixes the order.

import { lt, lte } from 'drizzle-orm'
import { buildSeries } from '../exposure/series'
import { dependencyEdges } from '../utils/terminal-dependencies'
import { filedBefore, filedFactsAt } from '../utils/terminal-exposure'
import { PointInTimeError } from '#layers/core/server/utils/terminal-asof'
import * as tables from '#server/db/schema'
import type { PipelineDb } from '#layers/core/server/pipeline/store'
import {
  CIK,
  plainTable,
  type ColumnDocs,
  type ExportTable,
  type Row,
} from '#layers/core/server/utils/terminal-export-views'

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
  filed_text_facts: plainTable(
    'filed_text_facts',
    'What Amazon’s 10-Qs and 10-Ks said about Anthropic in words before it tagged amzn:AnthropicMember (filings from 2023-10-27 to 2026-02-06): each convertible note bought, the notes committed to, their fair value, and later the gains and upward marks Anthropic brought. One row per figure per filing, with the sentence that states it. Amazon’s numbers, never Anthropic’s. Rows are never edited.',
    tables.filedTextFacts,
    {
      id: {
        type: 'text',
        key: true,
        meaning: 'SHA-256 (hex) of ticker, metric, start, end, and accession_no.',
      },
      ticker: { type: 'text', meaning: 'The filer: AMZN.' },
      cik: CIK,
      lab: { type: 'text', meaning: 'The lab the sentence names: anthropic.' },
      metric: {
        type: 'text',
        meaning:
          'notes_invested (notes bought over the period), notes_commitment (notes still to be bought, by end), notes_fair_value, investment_value (notes and preferred stock together), preferred_recorded (preferred stock on the balance sheet), upward_adjustment (marks on private holdings over the period), conversion_gain (gain on notes converted to preferred stock over the period), or preferred_carrying_value.',
      },
      start: {
        type: 'date',
        nullable: true,
        meaning: 'The period’s first day. Null for a balance or a commitment, which is at end.',
      },
      end: {
        type: 'date',
        meaning: 'The period’s last day, the balance date, or the commitment’s due date.',
      },
      value: { type: 'number', unit: 'USD', meaning: 'The figure as the sentence states it.' },
      unit: { type: 'text', meaning: 'Always USD: every figure read is in dollars.' },
      qualifier: {
        type: 'text',
        nullable: true,
        meaning:
          'approximately when the sentence says so; primarily when Amazon says the figure is mostly from Anthropic, so it includes other companies. Null otherwise.',
      },
      sentence: { type: 'text', meaning: 'The filing’s sentence, as printed.' },
      form: { type: 'text', meaning: 'The filing’s form: 10-Q or 10-K.' },
      filed: { type: 'date', meaning: 'The filing date EDGAR gives the accession.' },
      accession_no: { type: 'text', meaning: 'The filing’s EDGAR accession number.' },
      raw_key: {
        type: 'text',
        meaning: 'Key of the filing’s primary document in this site’s object store (R2).',
      },
      first_seen_at: { type: 'timestamp', meaning: 'When we first read the figure, in UTC.' },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The filing’s primary document on sec.gov.',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When that read ran, in UTC. A row is never rewritten.',
      },
    },
    [tables.filedTextFacts.filed, tables.filedTextFacts.id],
    async (_db, at) => lt(tables.filedTextFacts.filed, filedBefore(at)),
    undefined,
    { ticker: tables.filedTextFacts.ticker },
  ),
  filed_guidance: plainTable(
    'filed_guidance',
    'Forward guidance as a company stated it. source release: the capex figure in each earnings release Microsoft, Alphabet, Amazon, Meta, and Oracle furnish (exhibit 99.1 of an 8-K with item 2.02), one row per fiscal year, with the release’s own sentence. The other sources are the earnings calls of the 45 listed companies: an 8-K or 6-K exhibit, a transcript or prepared remarks the company posts, or our transcript of the replay; one row per figure, with a quote of at most 25 words. guidance_resolutions holds how each was settled. Rows are never edited.',
    tables.filedGuidance,
    {
      id: {
        type: 'text',
        key: true,
        meaning: 'SHA-256 (hex) of ticker, accession_no, and fiscal_year.',
      },
      ticker: { type: 'text', meaning: 'The company’s ticker.' },
      cik: CIK,
      accession_no: {
        type: 'text',
        meaning:
          'The earnings 8-K’s or 6-K’s EDGAR accession number; empty for a call document no filing carries.',
      },
      filed: {
        type: 'date',
        meaning: 'The filing date, as EDGAR gives it, or the date of the call.',
      },
      fiscal_year: {
        type: 'integer',
        meaning:
          'The year the sentence names. For a fiscal year that isn’t the calendar year, the year it ends in.',
      },
      low: {
        type: 'number',
        meaning: 'The low end of the range the sentence states, or its single figure, in unit.',
      },
      high: {
        type: 'number',
        meaning: 'The high end of the range, in unit. Equal to low for a single figure.',
      },
      sentence: {
        type: 'text',
        meaning:
          'The sentence the figure was read from: a release’s whole sentence, or at most 25 words of a call document’s, an ellipsis where it is cut.',
      },
      raw_key: {
        type: 'text',
        meaning: 'Key of the release in this site’s object store (R2).',
      },
      first_seen_at: { type: 'timestamp', meaning: 'When we first read the document, in UTC.' },
      source: {
        type: 'text',
        meaning:
          'release (the hyperscaler capex reader), exhibit, transcript (the company’s own), remarks (its prepared remarks), or audio (our transcript of its replay, never published).',
      },
      metric: {
        type: 'text',
        meaning: 'capex, revenue, segment_revenue, ai_revenue, gross_margin, or backlog.',
      },
      segment: {
        type: 'text',
        nullable: true,
        meaning: 'The business line a segment or AI figure is for, as the sentence names it.',
      },
      basis: {
        type: 'text',
        nullable: true,
        meaning: 'gaap or non_gaap when the sentence says; null otherwise.',
      },
      unit: {
        type: 'text',
        meaning:
          'USD; percent (a margin); growth_yoy or growth_qoq (revenue growth in percent, against a year or a quarter before).',
      },
      bound: {
        type: 'text',
        meaning: 'range, about (one figure), at_least, or at_most.',
      },
      fiscal_quarter: {
        type: 'integer',
        nullable: true,
        meaning: 'The guided fiscal quarter, 1 to 4; null for a fiscal year.',
      },
      period_start: { type: 'date', nullable: true, meaning: 'First day of the guided period.' },
      period_end: { type: 'date', nullable: true, meaning: 'Last day of the guided period.' },
      speaker: {
        type: 'text',
        nullable: true,
        meaning: 'Who said it, for a transcribed replay.',
      },
      at_ms: {
        type: 'integer',
        nullable: true,
        meaning: 'Milliseconds into the replay where the sentence starts.',
      },
      page: { type: 'integer', nullable: true, meaning: 'The PDF page the sentence is on.' },
      call_document_id: {
        type: 'text',
        nullable: true,
        meaning: 'The call_documents row the figure was read from.',
      },
      page_url: {
        type: 'text',
        nullable: true,
        meaning: 'The company’s own page for the call, or the filing’s EDGAR index.',
      },
      method: {
        type: 'text',
        meaning: 'parser (read by rule) or judge (read by the judge routine and checked).',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning:
          'The document the sentence was read from: the exhibit, or the company’s own file or page.',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When that read ran, in UTC. A document is never read again once read.',
      },
    },
    [tables.filedGuidance.filed, tables.filedGuidance.id],
    async (_db, at) => lt(tables.filedGuidance.filed, filedBefore(at)),
    undefined,
    { ticker: tables.filedGuidance.ticker },
  ),
  guidance_resolutions: plainTable(
    'guidance_resolutions',
    'How each call guidance row in filed_guidance was settled: the figure a later 10-Q or 10-K filed for the same measure and period, read from XBRL company concepts, and the error against the guided midpoint. One row per guidance row, written the first time we held the filed figure. A row with no resolution is open (the period isn’t filed yet) or not scored (a segment, an AI line or a non-GAAP margin).',
    tables.guidanceResolutions,
    {
      id: { type: 'text', key: true, meaning: 'SHA-256 (hex) of guidance_id and accession_no.' },
      guidance_id: { type: 'text', meaning: 'The filed_guidance row it settles.' },
      ticker: { type: 'text', meaning: 'The company’s ticker.' },
      metric: { type: 'text', meaning: 'As filed_guidance.metric.' },
      actual: {
        type: 'number',
        meaning:
          'The filed figure, in the guidance row’s unit: USD, or percent for a margin or a growth rate.',
      },
      guided_mid: { type: 'number', meaning: 'The midpoint of the guided low and high.' },
      error_share: {
        type: 'number',
        meaning:
          '(actual − guided_mid) / guided_mid for USD; (actual − guided_mid) / 100 for a percentage. Positive is a beat.',
      },
      state: {
        type: 'text',
        meaning:
          'met (inside the range, or within 5% of one figure, half a point for a percentage), above, or below.',
      },
      concept: {
        type: 'text',
        meaning: 'The XBRL concept the filed figure is (the last part, for a sum or a ratio).',
      },
      form: { type: 'text', meaning: 'The filing’s form, 10-Q or 10-K.' },
      filed: {
        type: 'date',
        meaning: 'The day the figure became public: the latest filing it needs.',
      },
      accession_no: { type: 'text', meaning: 'That filing’s EDGAR accession number.' },
      first_seen_at: { type: 'timestamp', meaning: 'When we first held the filed figure, in UTC.' },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The EDGAR company-concept document the figure was read from.',
      },
      fetched_at: { type: 'timestamp', provenance: true, meaning: 'When that read ran, in UTC.' },
    },
    [tables.guidanceResolutions.first_seen_at, tables.guidanceResolutions.id],
    async (_db, at) => lte(tables.guidanceResolutions.first_seen_at, at),
    undefined,
    { ticker: tables.guidanceResolutions.ticker },
  ),
  call_documents: plainTable(
    'call_documents',
    'Every document an earnings call of the 45 listed companies is read from: the EX-99 exhibits of its earnings 8-K or 6-K, the transcripts and prepared remarks the company posts, and the replays we send to AssemblyAI, with what each read found. The text and our transcripts are kept privately and never served; this lists where each came from and its state.',
    tables.callDocuments,
    {
      id: { type: 'text', key: true, meaning: 'SHA-256 (hex) of the document URL.' },
      ticker: { type: 'text', meaning: 'The company’s ticker.' },
      call_date: { type: 'date', meaning: 'The call’s date, or its earnings filing’s.' },
      period_label: { type: 'text', meaning: 'The quarter the call reported, e.g. Q3 FY2027.' },
      fiscal_year: { type: 'integer', meaning: 'That quarter’s fiscal year.' },
      fiscal_quarter: { type: 'integer', meaning: 'That quarter, 1 to 4.' },
      kind: { type: 'text', meaning: 'exhibit, transcript, remarks, or audio.' },
      url: { type: 'text', meaning: 'The document, or the replay’s audio file.' },
      page_url: {
        type: 'text',
        nullable: true,
        meaning: 'The company’s own page for the call, or the filing’s EDGAR index.',
      },
      produced_by: {
        type: 'text',
        nullable: true,
        meaning:
          'Who produced a transcript where it says (LSEG, FactSet, S&P Global, Bloomberg), the exhibit type, or AssemblyAI.',
      },
      accession_no: {
        type: 'text',
        nullable: true,
        meaning: 'The earnings filing an exhibit is from.',
      },
      status: {
        type: 'text',
        meaning:
          'pending, submitted (a replay with AssemblyAI), read, or failed (after three tries).',
      },
      detail: { type: 'text', nullable: true, meaning: 'Why a read failed, or found no text.' },
      audio_seconds: {
        type: 'number',
        nullable: true,
        meaning: 'A replay’s length as AssemblyAI billed it.',
      },
      statements: { type: 'integer', meaning: 'Guidance rows the read stored.' },
      first_seen_at: { type: 'timestamp', meaning: 'When we first listed the document, in UTC.' },
      read_at: { type: 'timestamp', nullable: true, meaning: 'When it was read, in UTC.' },
      source_url: { type: 'text', provenance: true, meaning: 'The document’s URL.' },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When it was last fetched, in UTC.',
      },
    },
    [tables.callDocuments.first_seen_at, tables.callDocuments.id],
    async (_db, at) => lte(tables.callDocuments.first_seen_at, at),
    undefined,
    { ticker: tables.callDocuments.ticker },
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

/**
 * Every exposure series point (layers/companies/server/exposure/series.ts),
 * built in memory from filed_facts: a few thousand facts at most. As of T it
 * is built from the facts filed before T's UTC day.
 */
export function exposureView(name: string, description: string, docs: ColumnDocs): ExportTable {
  const columns = Object.keys(docs)
  const build = async (db: PipelineDb, at: string | null): Promise<Row[]> => {
    const facts = await db
      .select()
      .from(tables.filedFacts)
      .where(at ? lt(tables.filedFacts.filed, filedBefore(at)) : undefined)
    return buildSeries(facts).flatMap((s) =>
      s.points.map((p) => ({
        series_id: s.id,
        ticker: s.ticker,
        filer: s.filer,
        group: s.group,
        label: s.label,
        concept: s.concept,
        dims: s.dims,
        kind: s.kind,
        unit: s.unit,
        start: p.start,
        end: p.end,
        value: p.value,
        derived: p.derived,
        less_start: p.less?.start ?? null,
        less_end: p.less?.end ?? null,
        less_value: p.less?.value ?? null,
        less_accession_no: p.less?.accession_no ?? null,
        accession_no: p.accession_no,
        form: p.form,
        filed: p.filed,
        filing_url: p.filing_url,
        source_url: p.source_url,
        fetched_at: p.fetched_at,
      })),
    )
  }
  const view = (at: string | null): ExportTable => ({
    name,
    description,
    columns,
    docs,
    async page(db, after, limit) {
      const rows = await build(db, at)
      const from =
        after === null
          ? 0
          : rows.findIndex((r) => r.series_id === after.series_id && r.end === after.end) + 1
      return rows.slice(from, from + limit)
    },
    count: async (db) => (await build(db, at)).length,
    at: (_db, instant) =>
      at === null
        ? Promise.resolve(view(instant))
        : Promise.reject(new PointInTimeError('already a point-in-time view')),
    asOfRefusal: null,
    pointInTime: 'cut',
  })
  return view(null)
}
