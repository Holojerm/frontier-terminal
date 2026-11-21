// SEC filers, filed revenue, and the parts of registration filings. Part of EXPORT_TABLES (server/registries/export-tables.ts), which fixes the order.

import { riskFactorChanges } from '../pipeline/parsers/sec/prospectus-risk-factors'
import {
  CIK,
  entityKey,
  entityView,
  filing,
  filingKeyDoc,
  list,
  none,
  partsView,
  priorHeadings,
  usd,
  verbatim,
  type Sections,
  type ExportTable,
} from '#layers/core/server/utils/terminal-export-views'

export const FILING_TABLES = {
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
    filingKeyDoc('statement:<cik>:<accession_no>:<start>:<end>'),
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
    filingKeyDoc('commitment:<accession_no>:<schedule>:<as_of, or undated>'),
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
    filingKeyDoc('concentration:<accession_no>:<basis>'),
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
    filingKeyDoc('shares:<accession_no>'),
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
    filingKeyDoc('risk_factors:<accession_no>'),
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
} satisfies Record<string, ExportTable>
