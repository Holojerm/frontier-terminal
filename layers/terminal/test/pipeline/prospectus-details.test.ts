import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { contentHashOfText, type ProspectusOutput } from '../../server/pipeline/contracts'
import { diff } from '../../server/pipeline/diff'
import { laneFor } from '../../server/pipeline/lanes'
import {
  normalizeDocuments,
  normalizeOfferings,
  normalizeProspectusDetails,
  normalizeRevenues,
} from '../../server/pipeline/normalize'
import {
  REGISTRATION_FIXTURE,
  archivesCik,
  registrationTarget,
} from '../../server/pipeline/parsers/sec/filing-index'
import { PROSPECTUS_FIXTURE, parseProspectus } from '../../server/pipeline/parsers/sec/prospectus'
import { docLines, docText, figure } from '../../server/pipeline/parsers/sec/prospectus-doc'
import { riskFactorChanges } from '../../server/pipeline/parsers/sec/prospectus-risk-factors'
import { prospectusFloorAlerts } from '../../server/pipeline/prospectus-floor'
import { runRefresh, type RawStore } from '../../server/pipeline/refresh'
import { insertRows } from '../../server/pipeline/store'
import { terminalStamp } from '../../server/utils/terminal-cache'
import { queryContext } from '../../server/utils/terminal-db'
import { EXPORT_TABLES, collect, csvChunks } from '../../server/utils/terminal-export'
import { queryProspectus } from '../../server/utils/terminal-prospectus'
import { statementValue } from '../../shared/utils/terminal-prospectus'
import { fixtureText, provenanceOf } from './fixtures'

// What a lab's registration filings print beyond revenue, read off the real
// S-1 and S-1/A: the statement of operations line by line, commitments,
// customer concentration, share counts and risk-factor headings — then the
// lane, the alert, the query layer and the exports over them.

const db = drizzle(env.DB, { schema })
const CIK = '0002130357'
const S1 = registrationTarget(REGISTRATION_FIXTURE.key)
const S1A = registrationTarget(PROSPECTUS_FIXTURE.key)
const s1Html = fixtureText(REGISTRATION_FIXTURE.prospectusPath)
const s1aHtml = fixtureText(PROSPECTUS_FIXTURE.path)
const s1Prov = provenanceOf(REGISTRATION_FIXTURE.prospectusSourceId)
const s1aProv = provenanceOf(PROSPECTUS_FIXTURE.sourceId)
const s1 = parseProspectus(s1Html, S1, CIK, s1Prov)
const s1a = parseProspectus(s1aHtml, S1A, CIK, s1aProv)

const lineOf = (out: ProspectusOutput, end: string, key: string) =>
  out.statements
    .find((s) => s.end === end && s.start.startsWith(end.slice(0, 4)))!
    .lines.find((l) => l.key === key)

describe('the statement of operations, every line', () => {
  it('reads the S-1/A’s nine months to September and both audited years', () => {
    expect(s1a.statements.map((s) => [s.start, s.end, s.unaudited ?? false])).toEqual([
      ['2023-01-01', '2023-12-31', false],
      ['2024-01-01', '2024-12-31', false],
      ['2025-01-01', '2025-09-30', true],
      ['2025-01-01', '2025-12-31', false],
      ['2026-01-01', '2026-09-30', true],
    ])
    const nine = s1a.statements.at(-1)!
    expect(nine).toMatchObject({
      provider: 'anthropic',
      cik: CIK,
      entity_name: 'Anthropic, PBC',
      accession_no: S1A.accession_no,
      form: 'S-1/A',
      filed: '2026-11-02',
      units: '(In millions, except share amounts which are in thousands, and per share data)',
      ...s1aProv,
    })
    expect(nine.lines.map((l) => [l.key, l.label, l.val, l.unit])).toEqual([
      ['revenue', 'Revenue', 33_242_000_000, 'USD'],
      ['compute_and_infrastructure', 'Compute and infrastructure', 18_808_000_000, 'USD'],
      ['personnel', 'Personnel', 4_863_000_000, 'USD'],
      ['bartz_settlement', 'Bartz settlement', null, 'USD'],
      [
        'sales_marketing_and_partnerships',
        'Sales, marketing, and partnerships',
        5_529_000_000,
        'USD',
      ],
      [
        'other_operating_and_administrative',
        'Other operating and administrative',
        5_302_000_000,
        'USD',
      ],
      ['total_operating_expenses', 'Total operating expenses', 34_502_000_000, 'USD'],
      ['operating_income', 'Operating loss', -1_260_000_000, 'USD'],
      ['interest_income', 'Interest income', 2_359_000_000, 'USD'],
      [
        'change_in_fair_value_of_convertible_notes_derivative_liabilities_and_safes',
        'Change in fair value of convertible notes, derivative liabilities, and SAFEs',
        -94_324_000_000,
        'USD',
      ],
      ['other_income_expense_net', 'Other income (expense), net', -10_397_000_000, 'USD'],
      [
        'total_other_income_expense_net',
        'Total other income (expense), net',
        -102_362_000_000,
        'USD',
      ],
      [
        'loss_before_provision_for_income_taxes',
        'Loss before provision for income taxes',
        -103_622_000_000,
        'USD',
      ],
      ['provision_for_income_taxes', 'Provision for income taxes', 417_000_000, 'USD'],
      ['net_income', 'Net loss', -104_039_000_000, 'USD'],
      [
        'eps_basic_diluted',
        'Net loss per share attributable to common stockholders, basic and diluted',
        -50.1,
        'USD/share',
      ],
      [
        'weighted_shares_basic_diluted',
        'Weighted-average shares outstanding, basic and diluted',
        2_076_810_000,
        'shares',
      ],
    ])
    // The S-1 printed the same audited year; its six-month interims are its own.
    expect(lineOf(s1, '2025-12-31', 'net_income')!.val).toBe(-41_965_000_000)
    expect(lineOf(s1, '2026-06-30', 'operating_income')!.val).toBe(-693_000_000)
    // The revenue rows the lane already stored are the statement's revenue line.
    expect(s1a.revenue.map((r) => r.val)).toEqual(
      s1a.statements.map((s) => s.lines.find((l) => l.key === 'revenue')!.val),
    )
  })

  it('refuses a statement that does not foot, or lacks a line it must print', () => {
    const slid = s1aHtml.replace('>18,808<', '>19,808<')
    expect(() => parseProspectus(slid, S1A, CIK, s1aProv)).toThrow(
      '"Total operating expenses" does not foot',
    )
    const unbalanced = s1aHtml.replace('>(1,260)<', '>(1,270)<')
    expect(() => parseProspectus(unbalanced, S1A, CIK, s1aProv)).toThrow(
      'operating line does not equal revenue less operating expenses',
    )
    const renamed = s1aHtml.replaceAll('>Net loss<', '>Net result<')
    expect(() => parseProspectus(renamed, S1A, CIK, s1aProv)).toThrow('lacks net_income')
    expect(() => figure('12.3.4', 'cell')).toThrow('cell is not a figure')
    expect(figure('$ (1.42)', 'cell')).toBe(-1.42)
    expect(figure('—', 'cell')).toBeNull()
  })

  it('prints in the panel’s units: $ millions, thousands of shares, $ per share', () => {
    expect(statementValue(-104_039_000_000, 'USD')).toBe('−104,039')
    expect(statementValue(2_076_810_000, 'shares')).toBe('2,076,810')
    expect(statementValue(-50.1, 'USD/share')).toBe('−50.10')
    expect(statementValue(null, 'USD')).toBe('—')
  })
})

describe('commitments', () => {
  it('reads MD&A’s obligations table, its aggregate, and the note’s schedule and interim total', () => {
    expect(
      s1a.commitments.map((c) => [c.schedule, c.as_of, c.audited, c.approximate, c.lines.length]),
    ).toEqual([
      ['contractual_obligations', '2026-09-30', false, false, 4],
      ['obligations_aggregate', null, false, true, 1],
      ['purchase_commitments', '2025-12-31', true, false, 1],
      ['purchase_commitments_interim', '2026-09-30', false, true, 1],
    ])
    const [table, aggregate, note, interim] = s1a.commitments
    expect(table!.lines.find((l) => l.label === 'Purchase commitments')).toEqual({
      label: 'Purchase commitments',
      total: 313_819_000_000,
      buckets: [
        { label: '2026', val: 5_053_000_000 },
        { label: '2027', val: 28_424_000_000 },
        { label: '2028', val: 43_473_000_000 },
        { label: '2029', val: 46_901_000_000 },
        { label: '2030', val: 44_214_000_000 },
        { label: 'Thereafter', val: 145_754_000_000 },
      ],
    })
    expect(table!.lines.at(-1)).toMatchObject({ label: 'Total', total: 319_993_000_000 })
    expect(aggregate!.lines[0]!.total).toBe(895_400_000_000)
    expect(aggregate!.statement).toContain('are approximately $895.4 billion')
    expect(note!.lines[0]).toMatchObject({
      label: 'Total non-cancelable contractual commitments',
      total: 54_559_000_000,
    })
    expect(interim!.lines[0]!.total).toBe(313_800_000_000)
  })

  it('records no row for a schedule the filing prints blank', () => {
    // The S-1 printed MD&A's table frame and the aggregate with every figure blank.
    expect(s1.commitments.map((c) => [c.schedule, c.as_of, c.lines[0]!.total])).toEqual([
      ['purchase_commitments', '2025-12-31', 54_559_000_000],
      ['purchase_commitments_interim', '2026-06-30', 265_600_000_000],
    ])
  })

  it('refuses a table whose rows do not add up or a filled table with no date', () => {
    const off = s1aHtml.replace('>313,819<', '>303,819<')
    expect(() => parseProspectus(off, S1A, CIK, s1aProv)).toThrow('do not foot')
    const undated = s1aHtml.replace(
      /(contractual obligations as of <\/font><font[^>]*>)September&#160;30, 2026/,
      '$1',
    )
    expect(() => parseProspectus(undated, S1A, CIK, s1aProv)).toThrow('figures but no as-of date')
  })
})

describe('concentration, shares and risk factors', () => {
  it('reads both 10% tables, a star as under the threshold', () => {
    const [revenue, receivables] = s1a.concentration
    expect(revenue!.basis).toBe('revenue')
    expect(revenue!.columns.map((c) => c.end)).toEqual([
      '2023-12-31',
      '2024-12-31',
      '2025-12-31',
      '2025-09-30',
      '2026-09-30',
    ])
    expect(revenue!.customers).toEqual([
      { label: 'Customer A', pct: [null, null, 12, 11, null] },
      { label: 'Customer B', pct: [null, null, 12, 14, null] },
      { label: 'Customer C', pct: [43, null, null, null, null] },
      { label: 'Customer D', pct: [11, null, null, null, null] },
    ])
    expect(receivables).toMatchObject({
      basis: 'accounts_receivable',
      columns: [
        { start: null, end: '2024-12-31', unaudited: false },
        { start: null, end: '2025-12-31', unaudited: false },
        { start: null, end: '2026-09-30', unaudited: true },
      ],
      customers: [
        { label: 'Customer A', pct: [null, 13, null] },
        { label: 'Customer E', pct: [null, null, 13] },
      ],
    })
    const bad = s1aHtml.replace('>43%<', '>43 pct<')
    expect(() => parseProspectus(bad, S1A, CIK, s1aProv)).toThrow('is not a percentage')
  })

  it('records the share counts the S-1/A leaves blank as null, and the ones it prints', () => {
    const shares = s1a.shares!
    expect(shares.lines.map((l) => [l.label, l.shares])).toEqual([
      ['Class A common stock offered by us', null],
      ['Class A common stock offered by the selling stockholders', null],
      ['Underwriters’ option to purchase additional shares of Class A common stock from us', null],
      ['Class A common stock to be outstanding after this offering', null],
      ['Class N common stock to be outstanding after this offering', null],
      ['Class T common stock to be outstanding after this offering', 1],
      ['Class E common stock to be outstanding after this offering', 0],
      ['Class F common stock to be outstanding after this offering', 1],
      [
        'Class A, Class N, Class T, Class E, and Class F common stock to be outstanding after this offering',
        null,
      ],
    ])
    expect(shares.before_as_of).toBe('2026-09-30')
    expect(shares.before).toEqual([
      { label: 'Class A common stock', shares: null },
      { label: 'Class N common stock', shares: null },
      { label: 'Class T common stock', shares: 1 },
      { label: 'Class F common stock', shares: 1 },
    ])
    // A filled-in summary, as the amendment that sets the range will print it.
    const filled = s1aHtml.replace(
      /(Class A common stock offered by us[\s\S]*?>) shares(<)/,
      '$112,500,000 shares$2',
    )
    expect(parseProspectus(filled, S1A, CIK, s1aProv).shares!.lines[0]!.shares).toBe(12_500_000)
  })

  it('reads every risk-factor heading under its subsection', () => {
    const rf = s1a.risk_factors
    expect(rf.sections.map((s) => [s.title, s.headings.length])).toEqual([
      ['Risks Related to our Business and Industry', 46],
      ['Risks Related to Privacy, Cybersecurity, and Intellectual Property', 12],
      ['Risks Related to Legal and Regulatory Matters', 6],
      ['Risks Related to Tax and Accounting Matters', 7],
      ['Risks Related to our Governance Structure', 9],
      ['Risks Related to Ownership of our Class A Common Stock', 8],
    ])
    expect(rf.sections[0]!.headings[0]).toBe(
      'Our success depends in large part on our ability to continue to develop the most advanced and capable AI models, and any failure to do so could adversely affect our business.',
    )
    // A heading that crosses a page is one heading, the page number skipped.
    expect(rf.sections.flatMap((s) => s.headings).every((h) => !/ \d{1,3} /.test(h))).toBe(true)
    const lines = docLines(s1aHtml)
    const noSection = docText(lines.filter((l) => l.text !== 'Risk Factors'))
    expect(noSection.text).not.toContain('Risk Factors Investing')
  })

  it('says what an amendment did to the headings: the S-1/A only rewords eight', () => {
    const changes = riskFactorChanges(s1.risk_factors, s1a.risk_factors)
    expect(changes.map((c) => c.kind)).toEqual(Array(8).fill('reworded'))
    expect(changes.find((c) => c.heading.includes('ESG'))).toEqual({
      kind: 'reworded',
      section: 'Risks Related to Legal and Regulatory Matters',
      heading:
        'Increasing scrutiny and changing expectations from regulators, our investors, customers, and employees with respect to ESG may result in additional compliance risk and costs and may impact our reputation and business.',
      previous:
        'Increasing scrutiny and changing expectations from global regulations, our investors, customers, and employees with respect to ESG may result in additional compliance risk and costs and may impact our reputation and business.',
    })
    const added = {
      sections: [
        ...s1a.risk_factors.sections.slice(1),
        { title: 'Risks Related to Export Controls', headings: ['We depend on export licenses.'] },
      ],
    }
    expect(riskFactorChanges(s1a.risk_factors, added).map((c) => [c.kind, c.section])).toEqual([
      ['added', 'Risks Related to Export Controls'],
      ...Array(46).fill(['removed', 'Risks Related to our Business and Industry']),
    ])
  })
})

// ── the lane, the alert, the query layer, the exports ──────────────────────

const raw: RawStore = { put: async () => {} }
let tick = Date.parse('2026-11-04T14:00:00Z')
const now = () => new Date((tick += 1000))

async function store(out: ProspectusOutput, sourceId: string, details = true) {
  const rows = [
    ...normalizeRevenues(out.revenue, 'snap', 'anthropic'),
    ...normalizeOfferings(out.offering ? [out.offering] : [], 'snap'),
    ...(details ? normalizeProspectusDetails(out, 'snap') : []),
  ]
  await insertRows(
    db,
    'entities',
    rows.map((r) => ({ ...r, source_id: sourceId, first_seen_at: r.fetched_at })),
  )
}

beforeEach(async () => {
  for (const table of [
    schema.sourceRuns,
    schema.sourceStats,
    schema.alerts,
    schema.changes,
    schema.entities,
    schema.snapshots,
  ]) {
    await db.delete(table)
  }
})

describe('a document read before the lane read its details', () => {
  it('is parsed again although its bytes are unchanged, adding only the new rows', async () => {
    const id = PROSPECTUS_FIXTURE.sourceId
    // As production holds it: the filing index that located the S-1/A, and the
    // S-1/A's revenue and cover from an earlier parse of the same bytes.
    const located = normalizeDocuments(
      [
        {
          provider: 'anthropic',
          cik: CIK,
          entity_name: 'Anthropic, PBC',
          accession_no: S1A.accession_no,
          form: 'S-1/A',
          filed: '2026-11-02',
          document: 'anthropicpbc-sx1ax1.htm',
          ...s1aProv,
        },
      ],
      'snap',
    )
    await db.insert(schema.entities).values(
      located.map((r) => ({
        ...r,
        source_id: `filing-index-${PROSPECTUS_FIXTURE.key}`,
        first_seen_at: r.fetched_at,
      })),
    )
    await store(s1a, id, false)
    const content = contentHashOfText(s1aHtml)
    await db.insert(schema.snapshots).values({
      id: `${id}:2026-11-02T15:00:00.000Z`,
      source_id: id,
      content_hash: content,
      raw_key: 'raw/old',
      http_status: 200,
      bytes: s1aHtml.length,
      source_url: s1aProv.source_url,
      fetched_at: '2026-11-02T15:00:00.000Z',
    })
    await db.insert(schema.sourceRuns).values({
      id: 'run-old',
      scope: 'survey',
      source_id: id,
      started_at: '2026-11-02T15:00:00.000Z',
      status: 'ok',
      detail: null,
      snapshot_id: `${id}:2026-11-02T15:00:00.000Z`,
      added: 7,
      removed: 0,
      modified: 0,
      source_url: s1aProv.source_url,
    })
    expect(await laneFor(id)!.stale!(db, id)).toBe(true)

    const report = await runRefresh(
      {
        db,
        raw,
        fetcher: async () => ({ ok: true, status: 200, text: s1aHtml, bytes: s1aHtml.length }),
        sourcesYaml: fixtureText('sources.yaml'),
        now,
      },
      'survey',
      [id],
    )
    expect(report.sources[0]).toMatchObject({ status: 'ok', added: 13, modified: 0, alerts: 0 })
    const changed = await db.select().from(schema.changes)
    expect([...new Set(changed.map((c) => c.entity_type))].sort()).toEqual([
      'commitment',
      'concentration',
      'risk_factors',
      'shares',
      'statement',
    ])
    expect(await laneFor(id)!.stale!(db, id)).toBe(false)
  })
})

describe('the risk-factor alert', () => {
  const headingsOnly = (sections: ProspectusOutput['risk_factors']['sections']) => {
    const amended = { ...s1a, risk_factors: { ...s1a.risk_factors, sections } }
    const rows = normalizeProspectusDetails(amended, 'snap').filter(
      (r) => r.entity_type === 'risk_factors',
    )
    return diff([], rows, '2026-11-04T14:00:00.000Z')
  }

  it('fires when an amendment adds or removes a heading, and names it', async () => {
    await store(s1, REGISTRATION_FIXTURE.prospectusSourceId)
    const sections = [
      ...s1a.risk_factors.sections.slice(0, -1),
      {
        ...s1a.risk_factors.sections.at(-1)!,
        headings: [
          ...s1a.risk_factors.sections.at(-1)!.headings.slice(1),
          'Our dual listing may depress the price of our Class A common stock.',
        ],
      },
    ]
    const [alert, ...rest] = await prospectusFloorAlerts(db, headingsOnly(sections))
    expect(rest).toEqual([])
    expect(alert).toMatchObject({ rule: 'prospectus-floor', severity: 'notable' })
    expect(alert!.headline).toBe(
      'Anthropic, PBC S-1/A: 1 risk factor added, 1 removed against the S-1 of 2026-10-26',
    )
    expect(alert!.explanation).toContain(
      'added “Our dual listing may depress the price of our Class A common stock.”; removed “',
    )
    expect(alert!.explanation).toMatch(/; reworded \d+\.$/)
  })

  it('stays silent when the headings were only reworded', async () => {
    await store(s1, REGISTRATION_FIXTURE.prospectusSourceId)
    expect(await prospectusFloorAlerts(db, headingsOnly(s1a.risk_factors.sections))).toEqual([])
  })
})

describe('GET /api/prospectus and the exports', () => {
  const ctx = async () =>
    queryContext(fixtureText('sources.yaml'), await terminalStamp(db), () => new Date(tick))

  it('shows each period once from the newest filing, the S-1’s halves beside the S-1/A’s nine months', async () => {
    await store(s1, REGISTRATION_FIXTURE.prospectusSourceId)
    await store(s1a, PROSPECTUS_FIXTURE.sourceId)
    const data = await queryProspectus(db, await ctx())
    expect(data.issuers.map((i) => i.provider)).toEqual(['anthropic'])
    const a = data.issuers[0]!
    expect(a.filings.map((f) => f.form)).toEqual(['S-1/A', 'S-1'])
    expect(a.statement.periods.map((p) => [p.end, p.days, p.form, p.unaudited])).toEqual([
      ['2026-09-30', 273, 'S-1/A', true],
      ['2026-06-30', 181, 'S-1', true],
      ['2025-12-31', 365, 'S-1/A', false],
      ['2025-09-30', 273, 'S-1/A', true],
      ['2025-06-30', 181, 'S-1', true],
      ['2024-12-31', 366, 'S-1/A', false],
      ['2023-12-31', 365, 'S-1/A', false],
    ])
    expect(a.statement.periods[0]!.filing_url).toBe(
      'https://www.sec.gov/Archives/edgar/data/2130357/000162828026068676/',
    )
    expect(a.statement.lines.find((l) => l.key === 'operating_income')!.values).toEqual([
      -1_260_000_000, -693_000_000, -8_060_000_000, -5_224_000_000, -2_135_000_000, -2_980_000_000,
      -551_000_000,
    ])
    expect(a.statement.superseded.map((p) => [p.end, p.form])).toEqual([
      ['2025-12-31', 'S-1'],
      ['2024-12-31', 'S-1'],
      ['2023-12-31', 'S-1'],
    ])
    expect(a.statement.gross_margin).toBeNull()
    expect(a.statement.not_printed).toEqual([
      'Cost of revenue',
      'Gross profit',
      'Research and development',
      'Sales and marketing',
      'General and administrative',
    ])
    expect(a.commitments.map((c) => [c.schedule, c.as_of, c.form])).toEqual([
      ['obligations_aggregate', null, 'S-1/A'],
      ['contractual_obligations', '2026-09-30', 'S-1/A'],
      ['purchase_commitments_interim', '2026-09-30', 'S-1/A'],
      ['purchase_commitments_interim', '2026-06-30', 'S-1'],
      ['purchase_commitments', '2025-12-31', 'S-1/A'],
    ])
    expect(a.concentration.map((c) => [c.basis, c.form])).toEqual([
      ['revenue', 'S-1/A'],
      ['accounts_receivable', 'S-1/A'],
    ])
    expect(a.shares!.form).toBe('S-1/A')
    expect(a.risk_factors.latest).toMatchObject({ form: 'S-1/A', count: 88 })
    expect(a.risk_factors.diffs).toHaveLength(1)
    expect(a.risk_factors.diffs[0]!.from.form).toBe('S-1')
    expect(a.risk_factors.diffs[0]!.changes).toHaveLength(8)
    expect(archivesCik(a.statement.periods[0]!.source_url)).toBe(CIK)
  })

  it('exports one row per line, bucket, share and heading, paging inside an entity', async () => {
    await store(s1, REGISTRATION_FIXTURE.prospectusSourceId)
    await store(s1a, PROSPECTUS_FIXTURE.sourceId)
    const statements = EXPORT_TABLES.prospectus_statements!
    expect(await statements.count(db)).toBe(10 * 17)
    const first = await statements.page(db, null, 7)
    const second = await statements.page(db, first.at(-1)!, 7)
    expect(first.map((r) => r.part)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(second.map((r) => r.part)).toEqual([7, 8, 9, 10, 11, 12, 13])
    expect(second[0]!.entity_key).toBe(first[0]!.entity_key)
    const csv = await collect(csvChunks(db, statements))
    expect(csv.trim().split('\r\n')).toHaveLength(1 + 170)
    expect(csv).toContain(`${S1A.accession_no},S-1/A,2026-11-02,2026-01-01,2026-09-30,true,`)

    const risk = await collect(csvChunks(db, EXPORT_TABLES.prospectus_risk_factors!))
    const rows = risk.trim().split('\r\n')
    expect(rows).toHaveLength(1 + 88 + 88)
    expect(rows.filter((r) => r.includes(',reworded,'))).toHaveLength(8)
    expect(
      rows.filter((r) => r.includes(S1A.accession_no) && r.includes(',unchanged,')),
    ).toHaveLength(80)

    expect(await EXPORT_TABLES.prospectus_commitments!.count(db)).toBe(
      // S-1/A: 4 lines × 7 + 1 + 7 + 1; S-1: 7 + 1.
      28 + 1 + 7 + 1 + 7 + 1,
    )
    expect(await EXPORT_TABLES.prospectus_concentration!.count(db)).toBe(2 * (4 * 5 + 2 * 3))
    expect(await EXPORT_TABLES.prospectus_shares!.count(db)).toBe(2 * (9 + 4))
  })
})
