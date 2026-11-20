import { describe, expect, it } from 'vitest'

import { listedForLab } from '../server/utils/terminal-lab-cuts'
import { buildListed } from '../server/utils/terminal-listed'
import { buildSuppliers } from '../server/utils/terminal-suppliers'
import { listedEvidence, listedGroup, listedTieText } from '../shared/utils/listed'
import type { PowerTicker } from '../shared/utils/power-sites'
import type { CuratedSuppliers, SupplierRow } from '../shared/utils/suppliers'
import type {
  DependencyEdge,
  DependencyFigure,
  DependencyNode,
} from '../shared/utils/terminal-dependencies'

// The three company tables as one list, over small tables of our own, then
// over the hand-read suppliers file.

const node = (over: Partial<DependencyNode> & Pick<DependencyNode, 'id' | 'kind'>) =>
  ({
    name: over.id,
    ticker: null,
    lab: null,
    contracts: null,
    capex: null,
    ...over,
  }) as DependencyNode
const edge = (from: string, to: string, kind: DependencyEdge['kind'], facts: number) =>
  ({
    id: `${from}>${to}:${kind}`,
    from,
    to,
    kind,
    reporter: kind === 'buys' ? to : from,
    weight: null,
    facts: Array.from({ length: facts }, () => ({}) as DependencyFigure),
  }) satisfies DependencyEdge

const GRAPH = {
  nodes: [
    node({ id: 'openai', kind: 'lab', name: 'OpenAI', lab: 'openai' }),
    node({ id: 'crux-ai', kind: 'venture', name: 'Crux AI' }),
    node({ id: 'MSFT', kind: 'filer', name: 'Microsoft', ticker: 'MSFT' }),
    node({ id: 'GOOGL', kind: 'filer', name: 'Alphabet', ticker: 'GOOGL', lab: 'google' }),
    node({ id: 'ORCL', kind: 'filer', name: 'Oracle', ticker: 'ORCL' }),
  ],
  edges: [
    edge('openai', 'MSFT', 'buys', 2),
    edge('MSFT', 'openai', 'funds', 5),
    edge('crux-ai', 'GOOGL', 'buys', 1),
  ],
}

const row = (over: Partial<SupplierRow>): SupplierRow => ({
  ticker: 'HOST',
  company: 'Host Co',
  layer: 'hosting',
  relation: 'customer',
  counterparty: 'Anthropic',
  counterparty_ticker: null,
  counterparty_lab: 'anthropic',
  figures: [],
  form: '10-Q',
  filed: '2026-11-04',
  period: 'Q3 2026',
  source_url: 'https://www.sec.gov/Archives/edgar/data/1/a.htm',
  source_title: 'Host Co 10-Q',
  quote: 'We executed a lease with Anthropic for critical IT capacity.',
  alias: null,
  fetched_at: '2026-11-19T12:00:00.000Z',
  ...over,
})
const TABLE: CuratedSuppliers = {
  rows: [
    row({}),
    row({ relation: 'investor', counterparty: 'Google', counterparty_lab: 'google' }),
    row({ relation: 'concentration', counterparty: 'Customer A', counterparty_lab: null }),
    row({
      ticker: 'CHIP',
      company: 'Chip Co',
      layer: 'chips',
      relation: 'concentration',
      counterparty: 'Customer A',
      counterparty_lab: null,
    }),
  ],
}

const POWER: PowerTicker[] = [
  {
    ticker: 'UTIL',
    company: 'Utility Co',
    roles: ['utility'],
    sites: ['Site One'],
    labs: ['openai'],
  },
  {
    ticker: 'HOST',
    company: 'Host Co',
    roles: ['host'],
    sites: ['Site Two', 'Site Three'],
    labs: ['anthropic'],
  },
]

const listed = buildListed(GRAPH, buildSuppliers(TABLE), { tickers: POWER })
const company = (ticker: string) => listed.companies.find((c) => c.ticker === ticker)!
const text = (ticker: string) => company(ticker).ties.map((t) => listedTieText(t, company(ticker)))

describe('buildListed', () => {
  it('gives one row per ticker: the graph’s filers, then suppliers by what they sell, then power', () => {
    expect(listed.companies.map((c) => c.ticker)).toEqual([
      'MSFT',
      'GOOGL',
      'ORCL',
      'CHIP',
      'HOST',
      'UTIL',
    ])
    expect(listed.counts).toEqual({ companies: 6, graph: 3, suppliers: 2, power: 2, lab_tied: 4 })
  })

  it('reads a filer’s lines from the graph and counts their figures', () => {
    expect(company('MSFT')).toMatchObject({
      lab: null,
      labs: ['openai'],
      ties: [{ source: 'graph', sells_to: ['OpenAI'], funds: ['OpenAI'], figures: 7 }],
    })
    expect(text('MSFT')).toEqual(['Sells to OpenAI. Funds OpenAI.'])
    expect(listedGroup(company('MSFT'))).toBe('Cloud and funder')
  })

  it('doesn’t count a customer that isn’t a tracked lab as one', () => {
    expect(company('GOOGL')).toMatchObject({ lab: 'google', labs: [] })
    expect(text('GOOGL')).toEqual(['Owns Google. Sells to Crux AI.'])
    expect(
      listedTieText(company('GOOGL').ties[0]!, { ...company('GOOGL'), company: 'Google' }),
    ).toBe('Is a tracked lab. Sells to Crux AI.')
    expect(listedGroup(company('GOOGL'))).toBe('Lab parent')
  })

  it('says so when a filer’s filings name no lab', () => {
    expect(company('ORCL')).toMatchObject({ lab: null, labs: [], site_labs: [] })
    expect(text('ORCL')).toEqual(['The figures we read from its filings name no lab.'])
    expect(listedEvidence(company('ORCL').ties[0]!)).toEqual({
      text: 'Its own filed sizes',
      to: '/dependencies#sizes',
    })
  })

  it('ties a supplier with only unnamed customers to no one', () => {
    expect(company('CHIP')).toMatchObject({ labs: [], site_labs: [] })
    expect(text('CHIP')).toEqual([
      'Its filings name no other company. 1 passage gives a share of revenue for a customer it doesn’t name.',
    ])
  })

  it('keeps a tie by site apart from a tie by filing, on one row', () => {
    const host = company('HOST')
    expect(host.labs).toEqual(['anthropic', 'google'])
    expect(host.site_labs).toEqual(['anthropic'])
    expect(text('HOST')).toEqual([
      'Sells to Anthropic. Issued shares or warrants to Google. 1 passage gives a share of revenue for a customer it doesn’t name.',
      'Site host at Site Two and Site Three, sites Epoch AI credits to Anthropic.',
    ])
    expect(listedGroup(host)).toBe('Data-center hosting, Site host')
    expect(host.ties.map(listedEvidence)).toEqual([
      { text: '3 filed passages', to: '/dependencies#suppliers' },
      { text: '2 sites', to: '/compute#suppliers' },
    ])
    expect(company('UTIL')).toMatchObject({ labs: [], site_labs: ['openai'] })
  })
})

describe('listedForLab', () => {
  const data = { as_of: null, computed_at: '2026-11-19T00:00:00.000Z', rule: '', ...listed }

  it('keeps the companies tied to the lab, by filing or by site, and counts that set', () => {
    const cut = listedForLab(data, 'anthropic')
    const kept = cut.companies.map((c) => c.ticker)
    for (const c of listed.companies) {
      const tied =
        c.lab === 'anthropic' || c.labs.includes('anthropic') || c.site_labs.includes('anthropic')
      expect(kept.includes(c.ticker)).toBe(tied)
    }
    expect(cut.counts.companies).toBe(kept.length)
    expect(cut.counts.lab_tied).toBe(kept.length)
    expect(cut.counts.graph + cut.counts.suppliers + cut.counts.power).toBeGreaterThanOrEqual(
      kept.length,
    )
  })

  it('keeps none for a lab no source names', () => {
    expect(listedForLab(data, 'moonshot').counts).toEqual({
      companies: 0,
      graph: 0,
      suppliers: 0,
      power: 0,
      lab_tied: 0,
    })
  })
})

describe('the hand-read suppliers file', () => {
  const suppliers = buildSuppliers()
  const real = buildListed(GRAPH, suppliers, { tickers: [] })

  it('lists every supplier once, with all of its passages', () => {
    const tied = real.companies.filter((c) => c.ties.some((t) => t.source === 'suppliers'))
    expect(tied.map((c) => c.ticker).sort()).toEqual(
      suppliers.companies.map((c) => c.ticker).sort(),
    )
    const passages = tied.flatMap((c) =>
      c.ties.map((t) => (t.source === 'suppliers' ? t.passages : 0)),
    )
    expect(passages.reduce((a, b) => a + b, 0)).toBe(suppliers.rows.length)
  })

  it('names a lab only where a passage does', () => {
    for (const c of real.companies) {
      const s = suppliers.companies.find((x) => x.ticker === c.ticker)
      if (s) expect(c.labs, c.ticker).toEqual(s.labs)
    }
  })
})
