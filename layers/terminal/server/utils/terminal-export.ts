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
// This file is the registry (EXPORT_TABLES). The parts each table is built
// from are in terminal-export-views.ts, the license window in
// terminal-export-history.ts, and the CSV and JSON encoding in
// terminal-export-format.ts.
//
// Pure functions of the Drizzle client, so layers/terminal/test/terminal-export.test.ts can
// drive them against the workerd D1 and read the bytes back.

import { and, lt, lte, sql } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'

import * as tables from '#server/db/schema'
import { riskFactorChanges } from '../pipeline/parsers/sec/prospectus-risk-factors'
import { alertsKnownAt, judgeCutoffAt } from './terminal-asof'
import { ENTITY_SECURITIES, ENTITY_SECURITY_COLUMNS } from './terminal-entities'
import { ENTITY_IDENTIFIERS, ENTITY_IDENTIFIER_COLUMNS } from './terminal-identifiers'
import { filedBefore } from './terminal-exposure'
import {
  CIK,
  PROVIDER,
  SOURCE_NAME,
  changeHash,
  changeJson,
  entityKey,
  entityView,
  exposureView,
  filing,
  filingKey,
  list,
  none,
  partsView,
  plainTable,
  price,
  priorHeadings,
  staticTable,
  type ExportTable,
  type Sections,
  type WrittenBy,
  usd,
  verbatim,
} from './terminal-export-views'

/**
 * Tables that were exported and no longer are, with the reason a request for
 * one is told (410, not 404: the URL existed). See docs/source-audit.md.
 */
export const WITHDRAWN_EXPORTS: Readonly<Record<string, string>> = {
  rankings_daily:
    'OpenRouter licenses its rankings CC BY 4.0 but says the dataset "is not intended to be re-served as a competing free API", so we no longer offer the raw per-model daily rows as a download. Per-lab shares and top models are still at /rankings and /api/rankings. You can get the rows from openrouter.ai/api/v1/datasets/rankings-daily with an OpenRouter key.',
}

// OpenRouter's per-model daily rows reach the change log as `ranking` changes
// with the row in before_json/after_json; the changes export leaves them out
// for the same reason rankings_daily is withdrawn.
const notRanking = sql`${tables.changes.entity_type} <> 'ranking'`

// The two tables that gain a row per source per tick are counted from
// source_stats; a count(*) over either reads every row ever written.
const loggedTotal = (column: SQLiteColumn) => sql<number>`coalesce(sum(${column}), 0)`

/** Rows whose own timestamp (the leading keyset column, so an index range) is at or before T. */
const byColumn =
  (column: SQLiteColumn): WrittenBy =>
  async (_db, at) =>
    lte(column, at)

export const EXPORT_TABLES: Readonly<Record<string, ExportTable>> = {
  snapshots: plainTable(
    'snapshots',
    'One row per fetch of every source, with its content hash, HTTP status, byte count, and the R2 key of the raw response.',
    tables.snapshots,
    {
      id: { type: 'text', key: true, meaning: 'The fetch: <source_id>:<fetched_at>.' },
      source_id: SOURCE_NAME,
      content_hash: { type: 'text', meaning: 'SHA-256 (hex) of the fetched body.' },
      raw_key: {
        type: 'text',
        meaning:
          'Key of the raw body in this site’s object store (R2). A fetch that found the same content points at the existing object.',
      },
      http_status: {
        type: 'integer',
        nullable: true,
        meaning: 'The response’s HTTP status. Null where none was recorded.',
      },
      bytes: {
        type: 'integer',
        unit: 'bytes',
        nullable: true,
        meaning: 'Size of the fetched body. Null where none was recorded.',
      },
      source_url: { type: 'text', provenance: true, meaning: 'The URL fetched.' },
      fetched_at: { type: 'timestamp', provenance: true, meaning: 'When the fetch ran, in UTC.' },
    },
    [tables.snapshots.fetched_at, tables.snapshots.id],
    byColumn(tables.snapshots.fetched_at),
    loggedTotal(tables.sourceStats.snapshot_count),
  ),
  prices_latest: entityView(
    'prices_latest',
    'The current price and catalog row per SKU and source, as each vendor page stated it at our last check.',
    'model',
    entityKey(
      'model:<provider>:<model_slug>, with :<tier> when the SKU has one',
      ' A models page and a pricing page can both list a SKU, so one entity_key can have two rows.',
    ),
    {
      model_slug: {
        type: 'text',
        meaning: 'The model’s identifier as the vendor’s page prints it.',
      },
      tier: {
        type: 'text',
        nullable: true,
        meaning:
          'The price tier, where a model has several (Google’s standard, batch, flex, and priority, or xAI’s long_context). Null for a single-tier SKU.',
      },
      context_window: {
        type: 'text',
        nullable: true,
        meaning:
          'The context window as printed (“500k”, “1M”), not converted to tokens. Null where the page states none.',
      },
      input_per_mtok: price('input tokens'),
      cached_input_per_mtok: price('cached input tokens (a cache hit)'),
      output_per_mtok: price('output tokens'),
      currency: { type: 'text', meaning: 'Always USD.' },
      effective_from: {
        type: 'date',
        nullable: true,
        meaning:
          'The day a scheduled price takes effect, where the page announces one. Null for the price in force.',
      },
      effective_until: {
        type: 'date',
        nullable: true,
        meaning:
          'The day the page says the price in force is replaced. Null when no change is scheduled.',
      },
      notes: verbatim(
        'Qualifiers the page prints beside the row (cache-write prices, promotions, deprecations)',
        'where it prints none',
      ),
    },
  ),
  jobs_open: entityView(
    'jobs_open',
    'Every role currently listed on the job boards we track. A closed role leaves this table and shows up in changes.',
    'job',
    entityKey('job:<provider>:<job_id>'),
    {
      job_id: {
        type: 'text',
        meaning:
          'The board’s own job id: an Ashby UUID, a Greenhouse number, or a Google careers id.',
      },
      title: verbatim('The role title'),
      department: {
        type: 'text',
        nullable: true,
        meaning:
          'The department as the board names it (on Google’s feed, its categories joined by commas). Null where the board gives none.',
      },
      team: {
        type: 'text',
        nullable: true,
        meaning: 'The team within the department. Ashby boards only. Null elsewhere.',
      },
      location: verbatim(
        'The location text, several locations in one string',
        'where the board gives none',
      ),
      employment_type: {
        type: 'text',
        nullable: true,
        meaning:
          'The employment type as the board labels it (FullTime, …). Null where the board does not carry one, as Greenhouse does not.',
      },
      published_at: {
        type: 'timestamp',
        nullable: true,
        meaning: 'When the board says the role was first published, with the board’s own offset.',
      },
      updated_at: {
        type: 'timestamp',
        nullable: true,
        meaning:
          'When the board says the listing last changed, with its own offset. Null where the board gives none (Google’s feed).',
      },
      company_name: {
        type: 'text',
        nullable: true,
        meaning:
          'The employer the board prints, verbatim. Every xAI row says SpaceXAI: that board lists SpaceX and xAI roles together.',
      },
    },
  ),
  incidents: entityView(
    'incidents',
    'Every status-page incident we’ve stored, with the vendor’s title, impact, and status verbatim, start and resolution, and components. Impact is null where the feed publishes none (Anthropic’s Atom feed doesn’t). We keep an incident after it drops out of its feed.',
    'incident',
    entityKey('incident:<provider>:<incident_id>'),
    {
      incident_id: { type: 'text', meaning: 'The status page’s own incident id.' },
      title: verbatim('The incident title'),
      impact: {
        type: 'text',
        nullable: true,
        meaning:
          'The vendor’s impact or severity word, verbatim and not mapped across vendors. Statuspage uses none, minor, major, and critical. Google Cloud uses low, medium, and high. Null where the feed publishes none, as Anthropic’s Atom feed does.',
      },
      status: {
        type: 'text',
        meaning:
          'The vendor’s status word, verbatim. Statuspage uses investigating, identified, monitoring, resolved, and postmortem. Google Cloud gives the latest update’s status (AVAILABLE once resolved).',
      },
      started_at: {
        type: 'timestamp',
        meaning: 'When the incident started, as the feed states it.',
      },
      resolved_at: {
        type: 'timestamp',
        nullable: true,
        meaning: 'When the incident was resolved, as the feed states it. Null while open.',
      },
      components: {
        type: 'json',
        meaning:
          'The affected components (Statuspage) or products (Google Cloud): an array of names, sorted, possibly empty.',
      },
      incident_url: { type: 'text', meaning: 'The incident’s own page on the status site.' },
    },
  ),
  disclosures: entityView(
    'disclosures',
    'Every entry on a lab’s own misalignment-disclosure index (only OpenAI publishes one). Each row has the report or notice, title, summary, model, and context verbatim, and the date the index prints beside it. A count measures what a lab disclosed, not how its models behaved.',
    'disclosure',
    entityKey('disclosure:<provider>:<kind>:<entry_id>'),
    {
      kind: { type: 'text', meaning: 'report or notice.' },
      entry_id: {
        type: 'text',
        meaning:
          'The entry’s id on the index: a report’s slug, or a notice’s id without “notice-”.',
      },
      title: verbatim('The entry’s title'),
      summary: verbatim('The index’s one-sentence summary'),
      model: verbatim('The model the report concerns', 'on a notice'),
      observed_during: verbatim('The context the behavior was observed in', 'on a notice'),
      listed_on: {
        type: 'date',
        meaning:
          'The date the index prints beside the entry: a report’s last update, a notice’s posting date. It moves when a report is revised.',
      },
      entry_url: { type: 'text', meaning: 'The entry’s own page.' },
    },
  ),
  disclosure_timelines: entityView(
    'disclosure_timelines',
    'The dates printed on each report’s own page. That’s every “Label: value” line verbatim, the discovery date, and the disclosure date where the page prints one.',
    'disclosure_timeline',
    entityKey('disclosure_timeline:<provider>:<entry_id>'),
    {
      entry_id: { type: 'text', meaning: 'The report’s slug. It joins disclosures.entry_id.' },
      title: verbatim('The report page’s own title'),
      lines: {
        type: 'json',
        meaning:
          'Every “Label: value” line of the page’s metadata, verbatim and in page order, minus “Report updated”: an array of {label, value} objects.',
      },
      discovered_on: {
        type: 'date',
        nullable: true,
        meaning:
          'The discovery date, from the line under any label the vendor uses for it, when that value is a single date. Null otherwise.',
      },
      disclosed_on: {
        type: 'date',
        nullable: true,
        meaning: 'A printed disclosure date, when the page has one that is a single date.',
      },
    },
  ),
  filers: entityView(
    'filers',
    'One row per lab whose CIK we found in its own registration filing (sources.yaml pending_filers). Each row has the CIK, EDGAR’s name for the filer, and the filing we read it from.',
    'filer',
    // provider is already a leading column of every entity view; naming it
    // again printed it twice in the CSV header.
    entityKey('filer:<provider>, one per lab'),
    {
      cik: CIK,
      name: verbatim('EDGAR’s display name for the filer'),
      resolved_form: {
        type: 'text',
        meaning: 'The form of the filing the CIK was read from (S-1, S-1/A).',
      },
      resolved_accession: { type: 'text', meaning: 'That filing’s EDGAR accession number.' },
      resolved_file_date: { type: 'date', meaning: 'The day that filing was filed.' },
    },
  ),
  revenue_facts: entityView(
    'revenue_facts',
    'One row per XBRL revenue fact, with the filer, tag, period, value in USD, and the filing that reported it. Facts come from EDGAR company facts, a filing’s segment XBRL (Google Cloud), and a prospectus’s XBRL. Rows are never edited. A restatement is a new row under its own accession.',
    'revenue',
    entityKey(
      'revenue:<cik>:<tag>:<accession_no>:<start>:<end>',
      ' A segment fact’s key ends with its segment member (:goog:GoogleCloudMember). There’s no segment column, so the key is what tells a segment value from the consolidated one.',
    ),
    {
      cik: CIK,
      entity_name: { type: 'text', meaning: 'The filer’s name as EDGAR or the filing gives it.' },
      taxonomy: {
        type: 'text',
        meaning:
          'us-gaap for an XBRL fact (the SEC’s tagged financial data). prospectus for a figure read off the statement of operations in a registration filing that tags no financials.',
      },
      tag: {
        type: 'text',
        meaning:
          'The XBRL revenue tag, or for prospectus the statement’s row label verbatim. Filers switch tags between years, so a series can span several.',
      },
      unit: { type: 'text', meaning: 'Always USD.' },
      start: { type: 'date', meaning: 'First day of the period the value covers.' },
      end: { type: 'date', meaning: 'Last day of the period the value covers.' },
      val: {
        type: 'number',
        unit: usd,
        meaning: 'The filer’s own value for the period, in US dollars, never scaled or rounded.',
      },
      accession_no: {
        type: 'text',
        meaning:
          'The filing that reported the value. A restatement is a new row under its own accession.',
      },
      fy: {
        type: 'integer',
        nullable: true,
        meaning: 'The fiscal year as the filer tagged it.',
      },
      fp: {
        type: 'text',
        nullable: true,
        meaning: 'The fiscal period as the filer tagged it: FY or Q1 to Q4.',
      },
      form: { type: 'text', meaning: 'The reporting filing’s form type (10-K, 10-Q, S-1, …).' },
      filed: { type: 'date', meaning: 'The day the reporting filing was filed.' },
      frame: {
        type: 'text',
        nullable: true,
        meaning:
          'SEC’s calendar frame (CY2026Q2) when this fact is the canonical one for it. Null otherwise.',
      },
      whitelist_cik: {
        type: 'text',
        nullable: true,
        meaning:
          'The CIK again when the filer is on the sources.yaml whitelist of filers whose filings alert. Null otherwise.',
      },
    },
  ),
  prospectus_statements: partsView(
    'prospectus_statements',
    'Every line of the statement of operations in a lab’s own registration filing (S-1, S-1/A). One row per filing, period, and line, with the line verbatim, a standard key where we have one, and the value in USD, shares, or USD per share. Null means the filing printed a dash. Interim periods are unaudited.',
    'statement',
    filingKey('statement:<cik>:<accession_no>:<start>:<end>'),
    {
      start: { type: 'date', meaning: 'First day of the period.' },
      end: { type: 'date', meaning: 'Last day of the period.' },
      unaudited: {
        type: 'boolean',
        meaning: 'True for an interim period, which registration statements print unaudited.',
      },
      units: {
        type: 'text',
        meaning:
          'The statement’s units line, verbatim (“in millions, except per share data”). val is already scaled out of it.',
      },
      line_key: {
        type: 'text',
        meaning:
          'A canonical key where the label is a known one (revenue, total_operating_expenses, operating_income, net_income, …), else the label slugged.',
      },
      label: verbatim('The line’s label as the statement prints it'),
      val: {
        type: 'number',
        unit: 'USD, USD per share, or shares, as unit says',
        nullable: true,
        meaning:
          'The line’s value in whole units, scaled out of the printed millions or thousands. Negative where the statement prints parentheses, null where it prints a dash.',
      },
      unit: { type: 'text', meaning: 'USD, USD/share, or shares.' },
    },
    (p) =>
      list(p.lines).map((l) => ({
        ...filing(p),
        start: p.start,
        end: p.end,
        unaudited: p.unaudited === true,
        units: p.units,
        line_key: l.key,
        label: l.label,
        val: l.val,
        unit: l.unit,
      })),
    none,
  ),
  prospectus_commitments: partsView(
    'prospectus_commitments',
    'Contractual commitments printed in a lab’s registration filing. That covers the contractual-obligations table in MD&A (management’s discussion and analysis), the purchase-commitment schedule in the commitments note, and the one-figure totals, as of each date stated. One row per schedule line and year bucket, with bucket “Total” for the line’s total. approximate marks a figure the filing calls approximate, and statement quotes its sentence.',
    'commitment',
    filingKey('commitment:<accession_no>:<schedule>:<as_of, or undated>'),
    {
      schedule: {
        type: 'text',
        meaning:
          'contractual_obligations (MD&A’s table), purchase_commitments (the commitments note’s audited schedule), purchase_commitments_interim (the note’s one-sentence interim total), or obligations_aggregate (MD&A’s one-sentence total).',
      },
      as_of: {
        type: 'date',
        nullable: true,
        meaning: 'The date the schedule is stated as of. Null when its sentence names none.',
      },
      audited: { type: 'boolean', meaning: 'True for a schedule in the audited notes.' },
      approximate: {
        type: 'boolean',
        meaning: 'True when the filing itself calls the figure approximate.',
      },
      line: verbatim('The obligation’s label'),
      bucket: {
        type: 'text',
        meaning:
          'When the amount falls due, as the filing labels it (“2026”, “Thereafter”), or Total for the line’s total.',
      },
      val: {
        type: 'number',
        unit: usd,
        meaning: 'The amount in US dollars, scaled out of the printed millions or thousands.',
      },
      statement: verbatim(
        'For a one-figure schedule, the sentence it was read from',
        'for a table',
      ),
    },
    (p) =>
      list(p.lines).flatMap((l) =>
        [{ label: 'Total', val: l.total }, ...list(l.buckets)].map((b) => ({
          ...filing(p),
          schedule: p.schedule,
          as_of: p.as_of,
          audited: p.audited,
          approximate: p.approximate,
          line: l.label,
          bucket: b.label,
          val: b.val,
          statement: p.statement,
        })),
      ),
    none,
  ),
  prospectus_concentration: partsView(
    'prospectus_concentration',
    'Customers at or above 10% of revenue or of accounts receivable, from a lab’s registration filing. One row per filing, basis, customer, and period or balance date, with customers named as the filing names them. A null pct is the filing’s “*”, which means under 10% (not zero).',
    'concentration',
    filingKey('concentration:<accession_no>:<basis>'),
    {
      basis: { type: 'text', meaning: 'revenue or accounts_receivable.' },
      customer: { type: 'text', meaning: 'The customer as the filing names it (“Customer A”).' },
      start: {
        type: 'date',
        nullable: true,
        meaning: 'First day of the revenue period. Null for a receivables balance.',
      },
      end: { type: 'date', meaning: 'Last day of the revenue period, or the balance date.' },
      unaudited: { type: 'boolean', meaning: 'True for an unaudited interim column.' },
      pct: {
        type: 'number',
        unit: 'percent, 0 to 100',
        nullable: true,
        meaning:
          'The customer’s share of revenue or of receivables. Null is the filing’s “*”: under 10%. It isn’t zero.',
      },
    },
    (p) => {
      const columns = list(p.columns)
      return list(p.customers).flatMap((c) =>
        columns.map((col, i) => ({
          ...filing(p),
          basis: p.basis,
          customer: c.label,
          start: col.start,
          end: col.end,
          unaudited: col.unaudited,
          pct: (c.pct as unknown[])[i] ?? null,
        })),
      )
    },
    none,
  ),
  prospectus_shares: partsView(
    'prospectus_shares',
    'Share counts from a lab’s registration filing. Each row of “The Offering” (shares offered, and each class outstanding after the offering, with the underwriters’ option where stated), plus the pre-offering counts it’s based on. Null while the filing leaves a count blank.',
    'shares',
    filingKey('shares:<accession_no>'),
    {
      measure: {
        type: 'text',
        meaning:
          'the_offering for a row of “The Offering” summary. before_offering for a pre-offering count it is based on.',
      },
      as_of: {
        type: 'date',
        nullable: true,
        meaning: 'The date a before_offering count is stated as of. Null on the_offering rows.',
      },
      label: verbatim('The row’s label'),
      shares: {
        type: 'integer',
        unit: 'shares',
        nullable: true,
        meaning: 'The count in whole shares. Null while the filing leaves it blank.',
      },
      with_option: {
        type: 'integer',
        unit: 'shares',
        nullable: true,
        meaning:
          'The count if the underwriters exercise their option in full, where the row states one. Null on before_offering rows.',
      },
    },
    (p) => [
      ...list(p.lines).map((l) => ({
        ...filing(p),
        measure: 'the_offering',
        as_of: null,
        label: l.label,
        shares: l.shares,
        with_option: l.with_option,
      })),
      ...list(p.before).map((l) => ({
        ...filing(p),
        measure: 'before_offering',
        as_of: p.before_as_of,
        label: l.label,
        shares: l.shares,
        with_option: null,
      })),
    ],
    none,
  ),
  prospectus_risk_factors: partsView(
    'prospectus_risk_factors',
    'Every risk-factor heading in a lab’s registration filing, verbatim and in order. Each is compared with the same filer’s previous filing and marked unchanged, added, reworded (previous holds the earlier words), or removed. A removed heading is one the previous filing printed and this one doesn’t, listed after this filing’s own.',
    'risk_factors',
    filingKey('risk_factors:<accession_no>'),
    {
      section: verbatim('The “Risks Related to …” subsection the heading sits under'),
      heading: verbatim('The risk-factor heading'),
      change: {
        type: 'text',
        nullable: true,
        meaning:
          'Against the same filer’s previous filing: unchanged, added, reworded, or removed (a heading only the previous filing printed). Null on a filer’s first filing.',
      },
      previous: verbatim('For a reworded heading, the previous filing’s words', 'otherwise'),
    },
    (p, prior) => {
      const sections = list(p.sections) as unknown as Sections
      const before = prior.get(String(p.accession_no))
      const changes = before
        ? riskFactorChanges(
            { sections: list(before.sections) as unknown as Sections },
            { sections },
          )
        : []
      const of = (heading: string) =>
        changes.find((c) => c.kind !== 'removed' && c.heading === heading)
      return [
        ...sections.flatMap((s) =>
          s.headings.map((heading) => ({
            ...filing(p),
            section: s.title,
            heading,
            change: before ? (of(heading)?.kind ?? 'unchanged') : null,
            previous: of(heading)?.previous ?? null,
          })),
        ),
        ...changes
          .filter((c) => c.kind === 'removed')
          .map((c) => ({
            ...filing(p),
            section: c.section,
            heading: c.heading,
            change: 'removed',
            previous: null,
          })),
      ]
    },
    priorHeadings,
  ),
  changes: plainTable(
    'changes',
    'The change log. Every tracked item added, removed, or modified, with its before and after values. Rows are never edited. OpenRouter ranking rows are left out (see rankings_daily on /data).',
    tables.changes,
    {
      id: {
        type: 'text',
        key: true,
        meaning:
          'SHA-256 (hex) of the entity key and the two content hashes, so the same change is never logged twice. A filed_fact change hashes its series, period, and accession instead.',
      },
      entity_key: {
        type: 'text',
        meaning: 'The changed row’s entity_key, as the views above use it.',
      },
      entity_type: {
        type: 'text',
        meaning:
          'The kind of row: model, job, incident, disclosure, disclosure_timeline, filer, revenue, filing, document, offering, statement, commitment, concentration, shares, risk_factors, recommendation, or filed_fact (a hyperscaler series point a new filing moved, cited by its alert). OpenRouter ranking rows are left out.',
      },
      provider: PROVIDER,
      change_type: { type: 'text', meaning: 'added, removed, or modified.' },
      before_hash: changeHash('before', 'added'),
      after_hash: changeHash('after', 'removed'),
      before_json: changeJson('before', 'added'),
      after_json: changeJson('after', 'removed'),
      detected_at: {
        type: 'timestamp',
        meaning: 'When the fetch that observed the change ran, in UTC. Same instant as fetched_at.',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The URL whose fetch observed the change.',
      },
      fetched_at: { type: 'timestamp', provenance: true, meaning: 'When that fetch ran, in UTC.' },
    },
    [tables.changes.detected_at, tables.changes.id],
    byColumn(tables.changes.detected_at),
    undefined,
    undefined,
    notRanking,
  ),
  archived_prices: plainTable(
    'archived_prices',
    'Price history from before we watched the labs: one row per SKU per Internet Archive copy of the lab’s own pricing page that we could read. source_url is the copy, captured_at when the Archive saw the page, fetched_at when we read the copy. Never mixed into the live tables.',
    tables.archivedPrices,
    {
      id: {
        type: 'text',
        key: true,
        meaning: 'The first 32 hex characters of the SHA-256 of capture_id and entity_key.',
      },
      capture_id: {
        type: 'text',
        meaning:
          'The copy the row was read from: <era>:<14-digit Wayback timestamp>, as in archive_captures.',
      },
      entity_key: {
        type: 'text',
        meaning:
          'The SKU: model:<provider>:<slug>[:<tier>], the same key the live prices use, so /prices/<key> shows this row before the live ones.',
      },
      provider: PROVIDER,
      content_hash: {
        type: 'text',
        meaning: 'SHA-256 (hex) of payload. Two copies with the same hash printed the same row.',
      },
      payload: {
        type: 'json',
        meaning:
          'The row as the page printed it, in the prices_latest fields: model_slug, tier, the three $/MTok prices (null where the page printed none), currency, and notes.',
      },
      captured_at: {
        type: 'timestamp',
        meaning:
          'When the Internet Archive captured the page, in UTC: the moment these prices were on it.',
      },
      original_url: { type: 'text', meaning: 'The lab’s own pricing page the Archive captured.' },
      basis: {
        type: 'text',
        meaning: 'Always archived: read from a copy, not observed by this site.',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning:
          'The Wayback Machine copy (https://web.archive.org/web/<timestamp>id_/<original_url>).',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When we read the copy back from the Archive, in UTC.',
      },
    },
    [tables.archivedPrices.captured_at, tables.archivedPrices.id],
    byColumn(tables.archivedPrices.captured_at),
  ),
  archived_hiring: plainTable(
    'archived_hiring',
    'Hiring history from before we read the labs’ job boards: open roles per Internet Archive copy of each lab’s own board that we could read. One board row per copy, and one row per department when the copy lists every role. source_url is the copy, captured_at when the Archive saw the board, fetched_at when we read the copy. Never mixed into the live tables.',
    tables.archivedHiring,
    {
      id: {
        type: 'text',
        key: true,
        meaning:
          'The first 32 hex characters of the SHA-256 of capture_id and the row’s scope or department.',
      },
      capture_id: {
        type: 'text',
        meaning:
          'The copy the count was read from: <era>:<14-digit Wayback timestamp>, as in archive_captures.',
      },
      provider: PROVIDER,
      scope: {
        type: 'text',
        meaning:
          'board (open roles on the whole board; one per copy) or department (one per department, when the copy lists every role; they sum to the board row).',
      },
      label: {
        type: 'text',
        nullable: true,
        meaning: 'The department as the board printed it then. Null on the board row.',
      },
      department_id: {
        type: 'text',
        nullable: true,
        meaning:
          'The board’s own id for the department (Greenhouse, Ashby), where the copy prints one. Null on the board row and on Lever boards.',
      },
      department: {
        type: 'text',
        nullable: true,
        meaning:
          'The live department the row files under: today’s label for the same department_id where the board’s id ties them, else the label as printed. Null on the board row.',
      },
      open_roles: {
        type: 'integer',
        unit: 'roles',
        meaning: 'Open roles the copy listed (department rows) or stated (board row).',
      },
      captured_at: {
        type: 'timestamp',
        meaning:
          'When the Internet Archive captured the board, in UTC: the moment these roles were open on it.',
      },
      original_url: { type: 'text', meaning: 'The lab’s own job board the Archive captured.' },
      basis: {
        type: 'text',
        meaning: 'Always archived: read from a copy, not observed by this site.',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning:
          'The Wayback Machine copy (https://web.archive.org/web/<timestamp>id_/<original_url>).',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When we read the copy back from the Archive, in UTC.',
      },
    },
    [tables.archivedHiring.captured_at, tables.archivedHiring.id],
    byColumn(tables.archivedHiring.captured_at),
  ),
  archive_captures: plainTable(
    'archive_captures',
    'Every Internet Archive copy the price- and hiring-history backfill considered: read (with how many rows it gave) or skipped, with the reason. A skipped copy gave no rows; nothing on it was guessed.',
    tables.archiveCaptures,
    {
      id: {
        type: 'text',
        key: true,
        meaning: 'The copy: <era>:<14-digit Wayback timestamp>.',
      },
      era: {
        type: 'text',
        meaning:
          'Which shape of the lab’s pricing page or job board the copy is read as (layers/terminal/server/pipeline/archive/eras.ts, hiring-eras.ts).',
      },
      provider: PROVIDER,
      original_url: {
        type: 'text',
        meaning: 'The lab’s own pricing page or job board the Archive captured.',
      },
      captured_at: {
        type: 'timestamp',
        meaning: 'When the Internet Archive captured the page, in UTC.',
      },
      status: {
        type: 'text',
        meaning:
          'parsed (its rows are in archived_prices or archived_hiring, by axis) or skipped (no rows; detail says why).',
      },
      detail: {
        type: 'text',
        nullable: true,
        meaning:
          'Why a skipped copy was skipped, in the parser’s or the fetch’s own words. On a read job board, what it held beyond the counts (a paged list: total only).',
      },
      content_hash: {
        type: 'text',
        nullable: true,
        meaning: 'SHA-256 (hex) of the copy’s text. Null when the fetch failed.',
      },
      raw_key: {
        type: 'text',
        nullable: true,
        meaning:
          'Key of the saved copy in this site’s object store (R2). Null when the fetch failed.',
      },
      bytes: {
        type: 'integer',
        nullable: true,
        unit: 'bytes',
        meaning: 'Size of the copy as read. Null when the fetch failed.',
      },
      rows: {
        type: 'integer',
        meaning: 'How many rows the copy gave, in archived_prices or archived_hiring (see axis).',
      },
      axis: {
        type: 'text',
        meaning:
          'pricing (a lab’s pricing page; rows in archived_prices) or hiring (a lab’s job board; rows in archived_hiring).',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning:
          'The Wayback Machine copy (https://web.archive.org/web/<timestamp>id_/<original_url>).',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When we read the copy (or tried to), in UTC.',
      },
    },
    [tables.archiveCaptures.captured_at, tables.archiveCaptures.id],
    byColumn(tables.archiveCaptures.captured_at),
  ),
  alerts: plainTable(
    'alerts',
    'Every alert fired, with the change ids it cites and the rule that produced it.',
    tables.alerts,
    {
      id: {
        type: 'text',
        key: true,
        meaning: 'SHA-256 (hex) of what the alert is about. Its page is /alerts/<id>.',
      },
      severity: { type: 'text', meaning: 'info, notable, or critical.' },
      headline: { type: 'text', meaning: 'The alert in one line.' },
      explanation: {
        type: 'text',
        meaning: 'Why it matters. It cites only fields in the changes it cites.',
      },
      change_ids: {
        type: 'json',
        meaning:
          'JSON text (a string in the JSON export too): an array of the changes.id it cites.',
      },
      rule: {
        type: 'text',
        meaning:
          'What wrote it: agent-judge (the judge routine), or a deterministic rule: s1-floor, periodic-floor, cik-resolved, model-floor, prospectus-floor, hiring-rollup, filed-fact-floor.',
      },
      created_at: {
        type: 'timestamp',
        meaning: 'When the alert counts from: the detection of the newest change it cites, in UTC.',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The URL of the change the alert is stamped from.',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When that change’s fetch ran, in UTC.',
      },
    },
    [tables.alerts.created_at, tables.alerts.id],
    async (db, at) => alertsKnownAt(at, await judgeCutoffAt(db, at)),
  ),
  claim_readings: plainTable(
    'claim_readings',
    'One row per thesis claim and data date: the measured value its kill condition is checked against, with the detail behind it (docs/theses/).',
    tables.claimReadings,
    {
      thesis_id: {
        type: 'text',
        meaning: 'The thesis the claim belongs to. Its page is /theses/<thesis_id>.',
      },
      claim_id: { type: 'text', key: true, meaning: 'The claim, unique across theses.' },
      date: { type: 'date', key: true, meaning: 'The data date the reading is for.' },
      value: {
        type: 'number',
        unit: 'the claim’s own: a 0..1 share, a ratio, a growth rate, a count, USD, or USD per million tokens',
        meaning:
          'The measured value the claim’s kill condition is checked against. The thesis page gives the claim’s unit.',
      },
      detail: {
        type: 'json',
        meaning:
          'JSON text (a string in the JSON export too): the inputs behind the value, shaped by the claim’s signal.',
      },
      computed_at: {
        type: 'timestamp',
        meaning: 'When the reading was last computed with a different value or detail, in UTC.',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The source of the reading’s newest input.',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When that input was fetched, in UTC.',
      },
    },
    [tables.claimReadings.claim_id, tables.claimReadings.date],
    'a claim reading is rewritten in place while its data is revised, and the value it replaced is not kept.',
  ),
  claim_verdicts: plainTable(
    'claim_verdicts',
    'The judge’s verdict on each candidate event for a judged thesis claim, with its rationale and the facts we computed (a price cut’s size, an outage’s hours). Rows are never edited.',
    tables.claimVerdicts,
    {
      id: {
        type: 'text',
        key: true,
        meaning: 'SHA-256 (hex) of claim_id and subject: one verdict per claim and subject.',
      },
      thesis_id: { type: 'text', meaning: 'The thesis the claim belongs to.' },
      claim_id: { type: 'text', meaning: 'The judged claim.' },
      subject: {
        type: 'text',
        meaning:
          'What the verdict rates: the changes.id of a price cut, the entity_key of an incident or disclosure (so an incident updated twice is rated once), or the recipe_observations.id of a recipe item.',
      },
      change_id: {
        type: 'text',
        meaning: 'The changes.id, or recipe_observations.id, of the record the judge was shown.',
      },
      provider: {
        type: 'text',
        meaning: 'The company the event concerns: a lab id, or a company id such as cloudflare.',
      },
      verdict: {
        type: 'text',
        meaning:
          'The judge’s verdict, from the claim’s own set: competitive or generational for a price cut, material or not-material for an incident or disclosure. A recipe claim lists its own.',
      },
      rationale: {
        type: 'text',
        meaning:
          'The judge’s reason, at most 600 characters, grounded against the record and the facts.',
      },
      facts: {
        type: 'json',
        meaning:
          'JSON text (a string in the JSON export too): what the Worker computed about the event, such as a cut’s size or an outage’s hours.',
      },
      detected_at: {
        type: 'text',
        meaning:
          'When the rated record was detected: the change’s detected_at (an ISO-8601 timestamp), or for a recipe item the observation’s date (YYYY-MM-DD).',
      },
      judged_at: {
        type: 'timestamp',
        meaning: 'When the judge run that wrote the verdict ran, in UTC.',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The URL the rated record was read from.',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When that record was fetched, in UTC.',
      },
    },
    [tables.claimVerdicts.detected_at, tables.claimVerdicts.id],
    // Judged after the change it rates; held back until it was judged.
    async (_db, at) =>
      and(lte(tables.claimVerdicts.detected_at, at), lte(tables.claimVerdicts.judged_at, at)),
  ),
  track_record_candidates: plainTable(
    'track_record_candidates',
    'Press articles (from GDELT) and lab newsroom posts found within 7 days either side of when we saw a notable or critical alert’s change. A candidate isn’t a match. track_record_verdicts says which ones report the same event. Rows are never edited.',
    tables.trackRecordCandidates,
    {
      id: {
        type: 'text',
        key: true,
        meaning: 'SHA-256 (hex) of alert_id, kind and url: one row per alert, kind and URL.',
      },
      alert_id: { type: 'text', meaning: 'The alerts.id the candidate was found for.' },
      kind: {
        type: 'text',
        meaning:
          'press, an article GDELT indexed, or newsroom, a post on the lab’s own newsroom feed.',
      },
      title: {
        type: 'text',
        meaning:
          'The headline as GDELT or the feed gives it. Press rows found through GDELT’s search API before 2026-11-07 keep its spaced punctuation (“GPT - 6 . 1”) as read.',
      },
      snippet: {
        type: 'text',
        nullable: true,
        meaning:
          'The first 400 characters of a newsroom post’s description. Null for press, since GDELT gives no article text.',
      },
      outlet: {
        type: 'text',
        meaning: 'The site’s domain, as GDELT names it or from the post’s link.',
      },
      url: { type: 'text', meaning: 'The article or post itself.' },
      published_at: {
        type: 'timestamp',
        meaning:
          'For press, the quarter hour GDELT’s crawler read the article (not when the outlet published it). For a newsroom post, its own publication time. UTC.',
      },
      search_id: {
        type: 'text',
        meaning:
          'The search that found it, or gkg:<quarter hour> for a press row read from that GDELT file. Searches aren’t exported. The page shows each one’s outcome.',
      },
      found_at: {
        type: 'timestamp',
        meaning: 'When the search or file that found it was recorded, in UTC.',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning:
          'The GDELT file the article was read from (a search-API query URL before 2026-11-07), or the newsroom feed the post was read from.',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When that file, query or feed was fetched, in UTC.',
      },
    },
    [tables.trackRecordCandidates.found_at, tables.trackRecordCandidates.id],
    byColumn(tables.trackRecordCandidates.found_at),
    undefined,
    { alert_id: tables.trackRecordCandidates.alert_id },
  ),
  track_record_verdicts: plainTable(
    'track_record_verdicts',
    'The judge’s rating of each track-record candidate: whether it reports the alert’s own event, with a rationale grounded in the headline and the alert’s change rows. Rows are never edited.',
    tables.trackRecordVerdicts,
    {
      id: {
        type: 'text',
        key: true,
        meaning: 'SHA-256 (hex) of candidate_id: one verdict per candidate.',
      },
      candidate_id: { type: 'text', meaning: 'The track_record_candidates.id rated.' },
      alert_id: { type: 'text', meaning: 'The alert the candidate was found for.' },
      same_event: {
        type: 'boolean',
        meaning:
          'True when the judge read the headline (and snippet) as reporting the alert’s own event. A vague headline is rated false.',
      },
      rationale: {
        type: 'text',
        meaning:
          'The judge’s reason, at most 400 characters, grounded against the headline and the alert’s change rows.',
      },
      judged_at: {
        type: 'timestamp',
        meaning: 'When the judge run that wrote the verdict ran, in UTC.',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The candidate’s own URL (the article or post rated).',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When the candidate was fetched, in UTC.',
      },
    },
    [tables.trackRecordVerdicts.judged_at, tables.trackRecordVerdicts.id],
    byColumn(tables.trackRecordVerdicts.judged_at),
    undefined,
    { alert_id: tables.trackRecordVerdicts.alert_id },
  ),
  reported_articles: plainTable(
    'reported_articles',
    'News articles (from GDELT) whose headline names a private lab we track, an amount of money and a financial word. Syndicated copies of one headline share a title_key. Rows are never edited.',
    tables.reportedArticles,
    {
      id: { type: 'text', key: true, meaning: 'SHA-256 (hex) of url: one row per article.' },
      title_key: {
        type: 'text',
        meaning:
          'The headline lowercased with punctuation removed. Copies of one headline on many sites share it, and the judge reads it once.',
      },
      title: { type: 'text', meaning: 'The headline as GDELT gives it.' },
      outlet: { type: 'text', meaning: 'The site’s domain, as GDELT names it.' },
      url: { type: 'text', meaning: 'The article itself.' },
      published_at: {
        type: 'timestamp',
        meaning:
          'The quarter hour GDELT’s crawler read the article (not when the outlet published it), UTC.',
      },
      found_at: { type: 'timestamp', meaning: 'When we stored the article, in UTC.' },
      record_id: {
        type: 'text',
        meaning: 'GDELT’s record id for the row, which finds it in the file at source_url.',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The GDELT file the article was read from.',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When that file was fetched, in UTC.',
      },
    },
    [tables.reportedArticles.found_at, tables.reportedArticles.id],
    byColumn(tables.reportedArticles.found_at),
  ),
  reported_figures: plainTable(
    'reported_figures',
    'Each lab revenue, valuation or funding figure a headline in reported_articles states, as our judge model labeled it. A label is kept only when its amount and lab are in the headline as written. Unaudited press figures, never mixed with filed ones. Rows are never edited.',
    tables.reportedFigures,
    {
      id: {
        type: 'text',
        key: true,
        meaning:
          'SHA-256 (hex) of title_key, lab, metric, basis and amount_text: one row per figure per headline.',
      },
      title_key: { type: 'text', meaning: 'The reported_articles.title_key of the headline.' },
      article_id: {
        type: 'text',
        meaning: 'The reported_articles.id of the earliest copy when the judge read it.',
      },
      lab: { type: 'text', meaning: 'The lab the figure is about, as its provider id.' },
      metric: {
        type: 'text',
        meaning:
          'revenue_run_rate (annualized or recurring), revenue (for a stated period), valuation, funding (one round) or funding_total (raised to date).',
      },
      basis: {
        type: 'text',
        meaning:
          'reported (given as fact), sought (in talks or planned) or projected (a forecast or target).',
      },
      currency: { type: 'text', meaning: 'USD or EUR, as the headline writes it.' },
      amount: { type: 'number', meaning: 'The amount in units of currency.' },
      amount_text: { type: 'text', meaning: 'The amount as the headline writes it.' },
      period: {
        type: 'text',
        nullable: true,
        meaning:
          'The period the headline names: a year, a quarter (2026-Q3) or a month. Null when it names none.',
      },
      published_at: {
        type: 'timestamp',
        meaning: 'When GDELT read the earliest copy of the headline, UTC.',
      },
      judged_at: { type: 'timestamp', meaning: 'When the judge run that labeled it ran, in UTC.' },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The earliest copy of the headline (the article read).',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When the GDELT file holding that copy was fetched, in UTC.',
      },
    },
    [tables.reportedFigures.judged_at, tables.reportedFigures.id],
    byColumn(tables.reportedFigures.judged_at),
    undefined,
    { lab: tables.reportedFigures.lab },
  ),
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
  source_runs: plainTable(
    'source_runs',
    'One row per check of each source, with what we tried and what happened. There’s no fetched_at column, since a failed run fetched nothing.',
    tables.sourceRuns,
    {
      id: { type: 'text', key: true, meaning: 'The run: <scope>:<source_id>:<started_at>.' },
      scope: {
        type: 'text',
        meaning:
          'Which poll ran it: edgar, survey, careers (the large careers feeds, on a six-hourly tick of their own), filings (the registration filings, likewise), or tripwire (an off-cycle poll of the model catalogs).',
      },
      source_id: SOURCE_NAME,
      started_at: {
        type: 'timestamp',
        provenance: true,
        meaning:
          'When the check started, in UTC. It stands in for fetched_at, since a failed run fetched nothing.',
      },
      status: {
        type: 'text',
        meaning:
          'ok, unchanged, failed, baseline (a first fetch, nothing to compare), skipped (the source needs a credential this deploy lacks), or absent (a URL derived from a stored row returned 404).',
      },
      detail: {
        type: 'text',
        nullable: true,
        meaning: 'What happened, in words: the error, or a count such as “104 entities”.',
      },
      snapshot_id: {
        type: 'text',
        nullable: true,
        meaning: 'The snapshots.id the run fetched. Null when no fetch succeeded.',
      },
      added: { type: 'integer', unit: 'rows', meaning: 'Rows the run logged as added.' },
      removed: { type: 'integer', unit: 'rows', meaning: 'Rows the run logged as removed.' },
      modified: { type: 'integer', unit: 'rows', meaning: 'Rows the run logged as modified.' },
      source_url: { type: 'text', provenance: true, meaning: 'The URL attempted.' },
    },
    [tables.sourceRuns.started_at, tables.sourceRuns.id],
    byColumn(tables.sourceRuns.started_at),
    loggedTotal(tables.sourceStats.run_count),
  ),
  entity_securities: staticTable(
    'entity_securities',
    'Each lab and SEC filer we track, mapped to the securities that carry it. Each row has the issuer, CIK, symbol, and exchange as EDGAR lists them, how the lab or filer relates to the security (itself, its parent, a disclosed investor), and the row’s source. A private lab with no security has a row saying so.',
    ENTITY_SECURITY_COLUMNS,
    {
      entity: {
        type: 'text',
        key: true,
        meaning: 'The lab or filer id (anthropic, microsoft, …), as the rest of the site uses it.',
      },
      entity_name: { type: 'text', meaning: 'The lab’s or filer’s name.' },
      entity_kind: {
        type: 'text',
        meaning: 'lab (one of the nine) or filer (a company whose filings the site reads).',
      },
      relationship: {
        type: 'text',
        meaning:
          'self (the entity is the issuer or part of it), parent (a public parent consolidates it), investor (the issuer discloses a stake in it), or none (no security carries it).',
      },
      issuer: {
        type: 'text',
        nullable: true,
        meaning: 'The issuer as EDGAR lists it. Null when no security carries the entity.',
      },
      cik: {
        ...CIK,
        nullable: true,
        meaning: 'The issuer’s SEC CIK, ten digits. Null with no issuer.',
      },
      symbol: {
        type: 'text',
        key: true,
        nullable: true,
        meaning:
          'The symbol as EDGAR lists it, or the proposed one for a registered issuer. Null with no security.',
      },
      exchange: {
        type: 'text',
        nullable: true,
        meaning: 'The exchange as EDGAR lists it. Null where no submissions feed is read.',
      },
      listing_status: {
        type: 'text',
        meaning: 'listed (trading), registered (an S-1 on file, not yet trading), or private.',
      },
      note: { type: 'text', nullable: true, meaning: 'How the mapping was made and its limits.' },
      mic: {
        type: 'text',
        nullable: true,
        meaning:
          'The ISO 10383 market identifier code OpenFIGI lists the symbol under: XNGS (Nasdaq Global Select Market) or XNYS (New York Stock Exchange). Null with no security.',
      },
      figi: {
        type: 'text',
        nullable: true,
        meaning:
          'The symbol’s US composite FIGI, from OpenFIGI. entity_identifiers has the URL and time it was read. Null with no security.',
      },
      disclosed_in: {
        type: 'text',
        nullable: true,
        meaning:
          'For a parent or investor row, the URL of the filing that discloses the relationship. Null for self and none.',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The document the row was checked against.',
      },
      checked_on: {
        type: 'date',
        provenance: true,
        meaning:
          'The day the row was checked against source_url. It stands in for fetched_at, since the row is checked by hand.',
      },
    },
    ENTITY_SECURITIES,
    'it’s a hand-checked table kept in code, and each row is dated by its checked_on.',
  ),
  entity_identifiers: staticTable(
    'entity_identifiers',
    'One row per company we name: each lab, each SEC filer we read, and each comparison company. Each row has the legal name, country, CIK, LEI, and for a listed company its ticker, MIC, and FIGI. Every identifier has the URL and time we read it. entity_id is the value of every provider and company column, so this is the table to join on.',
    ENTITY_IDENTIFIER_COLUMNS,
    {
      entity_id: {
        type: 'text',
        key: true,
        meaning:
          'Our id for the company. It’s the value of provider, company, and entity_securities.entity everywhere else.',
      },
      entity_name: { type: 'text', meaning: 'The name the site uses.' },
      entity_kind: {
        type: 'text',
        meaning:
          'lab (one of the nine), filer (a company whose SEC filings we read), or company (a comparison company in a thesis).',
      },
      legal_name: {
        type: 'text',
        nullable: true,
        meaning:
          'The legal name as GLEIF records it, or as the company’s own terms page prints it when GLEIF has no record. Null where we read neither.',
      },
      country: {
        type: 'text',
        nullable: true,
        meaning:
          'ISO 3166-1 alpha-2 country of the legal entity: GLEIF’s legal-address country, else the country the company’s own page names. Null where we read neither.',
      },
      listing_status: {
        type: 'text',
        meaning:
          'listed (its own shares trade), registered (an S-1 on file, not yet trading), subsidiary (owned by a listed parent, which entity_securities names), or private.',
      },
      cik: {
        ...CIK,
        nullable: true,
        meaning: 'The SEC CIK, ten digits, zero-padded. Null for a company that doesn’t file.',
      },
      cik_source_url: {
        type: 'text',
        nullable: true,
        provenance: true,
        meaning: 'Where the CIK was read: SEC’s company_tickers_exchange.json.',
      },
      cik_fetched_at: {
        type: 'timestamp',
        nullable: true,
        provenance: true,
        meaning: 'When we read the CIK, in UTC.',
      },
      lei: {
        type: 'text',
        nullable: true,
        meaning:
          'The ISO 17442 Legal Entity Identifier, from GLEIF. Null with the reason in lei_note.',
      },
      lei_status: {
        type: 'text',
        nullable: true,
        meaning:
          'GLEIF’s registration status for the LEI (ISSUED, LAPSED, …), as of lei_fetched_at.',
      },
      lei_note: {
        type: 'text',
        meaning: 'How the LEI was matched to the company, or why there’s none.',
      },
      lei_source_url: {
        type: 'text',
        nullable: true,
        provenance: true,
        meaning:
          'The GLEIF request the LEI was read from. For a null LEI, the search that found none, where we ran one.',
      },
      lei_fetched_at: {
        type: 'timestamp',
        nullable: true,
        provenance: true,
        meaning: 'When that GLEIF request ran, in UTC.',
      },
      ticker: {
        type: 'text',
        nullable: true,
        meaning:
          'The primary symbol as EDGAR lists it, or the proposed one for a registered company. entity_securities lists every symbol we map. Null when not listed.',
      },
      exchange: {
        type: 'text',
        nullable: true,
        meaning: 'The exchange as EDGAR’s ticker file lists it. Null when EDGAR gives none.',
      },
      mic: {
        type: 'text',
        nullable: true,
        meaning:
          'The ISO 10383 market identifier code OpenFIGI lists the symbol under (XNGS or XNYS). Null when not listed.',
      },
      figi: {
        type: 'text',
        nullable: true,
        meaning: 'The symbol’s US composite FIGI, from OpenFIGI. Null when not listed.',
      },
      share_class_figi: {
        type: 'text',
        nullable: true,
        meaning: 'The share-class FIGI OpenFIGI gives with it. Null when not listed.',
      },
      figi_source_url: {
        type: 'text',
        nullable: true,
        provenance: true,
        meaning: 'The OpenFIGI mapping API the FIGIs and MIC were read from.',
      },
      figi_fetched_at: {
        type: 'timestamp',
        nullable: true,
        provenance: true,
        meaning: 'When that OpenFIGI request ran, in UTC.',
      },
      note: { type: 'text', nullable: true, meaning: 'Anything a join needs to know.' },
      source_url: {
        type: 'text',
        nullable: true,
        provenance: true,
        meaning:
          'Where legal_name and country were read: GLEIF when there’s an LEI, else the company’s own terms page.',
      },
      fetched_at: {
        type: 'timestamp',
        nullable: true,
        provenance: true,
        meaning: 'When source_url was read, in UTC.',
      },
    },
    ENTITY_IDENTIFIERS,
    'it’s a registry kept in code, and each identifier is dated by its own fetched_at.',
  ),
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
  'archive_captures',
])

export function exportTable(name: string): ExportTable | null {
  return Object.prototype.hasOwnProperty.call(EXPORT_TABLES, name) ? EXPORT_TABLES[name]! : null
}
