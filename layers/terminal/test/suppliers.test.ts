import { describe, expect, it } from 'vitest'

import { comparable, pageText } from '../server/utils/quote-match'
import curated from '../server/curated/suppliers.json'
import { buildSuppliers } from '../server/utils/terminal-suppliers'
import { curatedSuppliers, supplierFigureText, type SupplierRow } from '../shared/utils/suppliers'

// The suppliers view over a small table of our own, so the grouping is tested
// apart from whatever the hand-read file holds, then the file's own rules.

const row = (over: Partial<SupplierRow>): SupplierRow => ({
  ticker: 'NETW',
  company: 'Network Co',
  layer: 'networking',
  relation: 'customer',
  counterparty: 'Microsoft',
  counterparty_ticker: 'MSFT',
  counterparty_lab: null,
  figures: [{ value: 20, unit: 'pct_revenue', meaning: 'share of fiscal 2025 revenue' }],
  form: '10-K',
  filed: '2026-02-18',
  period: 'fiscal 2025',
  source_url: 'https://www.sec.gov/Archives/edgar/data/1/a.htm',
  source_title: 'Network Co 10-K',
  quote: 'Microsoft and Meta Platforms represented 20% and 15% of our revenue.',
  alias: null,
  fetched_at: '2026-11-19T12:00:00.000Z',
  basis: 'hand',
  ...over,
})

const TABLE: { rows: SupplierRow[] } = {
  rows: [
    row({}),
    row({
      counterparty: 'Meta Platforms',
      counterparty_ticker: 'META',
      counterparty_lab: 'meta',
      figures: [{ value: 15, unit: 'pct_revenue', meaning: 'share of fiscal 2025 revenue' }],
    }),
    row({
      ticker: 'CHIP',
      company: 'Chip Co',
      layer: 'chips',
      relation: 'concentration',
      counterparty: 'Customer A',
      counterparty_ticker: null,
      counterparty_lab: null,
      figures: [{ value: 23, unit: 'pct_revenue', meaning: 'share of quarterly revenue' }],
      fetched_at: '2026-11-18T12:00:00.000Z',
    }),
    // An older document's larger share gives way to the newest one's.
    row({
      ticker: 'CHIP',
      company: 'Chip Co',
      layer: 'chips',
      relation: 'concentration',
      counterparty: 'one customer',
      counterparty_ticker: null,
      counterparty_lab: null,
      figures: [{ value: 40, unit: 'pct_revenue', meaning: 'share of fiscal 2025 revenue' }],
      filed: '2025-11-20',
    }),
    // A stake a lab holds in the company is a tie to the lab and no share of revenue.
    row({
      ticker: 'CHIP',
      company: 'Chip Co',
      layer: 'chips',
      relation: 'investor',
      counterparty: 'OpenAI',
      counterparty_ticker: null,
      counterparty_lab: 'openai',
      figures: [{ value: 160_000_000, unit: 'shares', meaning: 'warrant shares' }],
    }),
    row({
      ticker: 'RENT',
      company: 'Rent Co',
      layer: 'neocloud',
      relation: 'supplier',
      counterparty: 'NVIDIA',
      counterparty_ticker: 'NVDA',
      figures: [],
    }),
  ],
}

describe('suppliers', () => {
  const data = buildSuppliers(TABLE)
  const company = (t: string) => data.companies.find((c) => c.ticker === t)!

  it('orders companies by the largest share a filing puts on one customer', () => {
    expect(data.companies.map((c) => c.ticker)).toEqual(['CHIP', 'NETW', 'RENT'])
    expect(data.rows.map((r) => r.ticker)).toEqual(['CHIP', 'CHIP', 'CHIP', 'NETW', 'NETW', 'RENT'])
  })

  it('keeps a named customer’s share apart from an unnamed one', () => {
    expect(company('NETW').top_named_share).toMatchObject({ pct: 20, counterparty: 'Microsoft' })
    expect(company('NETW').top_unnamed_share).toBeNull()
    expect(company('CHIP').top_unnamed_share).toMatchObject({ pct: 23, counterparty: 'Customer A' })
    expect(company('CHIP').top_named_share).toBeNull()
  })

  it('takes a share for several customers together only where no single one is given', () => {
    const together = row({
      relation: 'concentration',
      counterparty: 'top five end customers',
      counterparty_ticker: null,
      figures: [{ value: 55, unit: 'pct_revenue_combined', meaning: 'share of quarterly revenue' }],
    })
    const one = row({
      relation: 'concentration',
      counterparty: 'our largest customer',
      counterparty_ticker: null,
      figures: [{ value: 19, unit: 'pct_revenue', meaning: 'share of 2025 revenue' }],
    })
    expect(buildSuppliers({ rows: [together] }).companies[0]!.top_unnamed_share).toMatchObject({
      pct: 55,
      combined: true,
    })
    expect(buildSuppliers({ rows: [together, one] }).companies[0]!.top_unnamed_share).toMatchObject(
      { pct: 19, combined: false },
    )
  })

  it('ties a company to a lab only through a counterparty the filing names', () => {
    expect(company('NETW').labs).toEqual(['meta'])
    expect(company('NETW').named.map((n) => n.name)).toEqual(['Microsoft', 'Meta Platforms'])
    expect(company('CHIP').labs).toEqual(['openai'])
    expect(company('CHIP').named.map((n) => n.name)).toEqual(['OpenAI'])
    expect(company('RENT').labs).toEqual([])
  })

  it('dates the table by its oldest check and says what is left out', () => {
    expect(data.as_of).toBe('2026-11-18T12:00:00.000Z')
    expect(data.gaps.find((g) => g.id === 'unnamed-customers')!.reason).toContain('2 rows give')
    expect(buildSuppliers({ rows: [] })).toMatchObject({ as_of: null, companies: [], rows: [] })
  })

  it('writes a figure the way a reader would', () => {
    const usd = (v: number) => `$${v / 1e9}B`
    expect(supplierFigureText({ value: 22.4e9, unit: 'usd', meaning: '' }, usd)).toBe('$22.4B')
    expect(supplierFigureText({ value: 20, unit: 'pct_revenue', meaning: '' }, usd)).toBe(
      '20% of revenue',
    )
    expect(supplierFigureText({ value: 160e6, unit: 'shares', meaning: '' }, usd)).toBe(
      '160M shares',
    )
    expect(supplierFigureText({ value: 6, unit: 'gw', meaning: '' }, usd)).toBe('6 GW')
  })
})

describe('the hand-read table', () => {
  const table = curatedSuppliers.parse(curated)

  it('names no one on a row for an unnamed customer', () => {
    const tied = table.rows.filter(
      (r) =>
        r.relation === 'concentration' &&
        (r.counterparty_ticker !== null || r.counterparty_lab !== null),
    )
    expect(tied.map((r) => `${r.ticker} ${r.counterparty}`)).toEqual([])
  })

  it('quotes the counterparty by the name on the row, or by a term the document defines', () => {
    const has = (quote: string, name: string) =>
      comparable(quote).toLowerCase().includes(comparable(name).toLowerCase())
    const missing = table.rows.filter((r) =>
      r.alias
        ? !has(r.quote, r.alias.term) ||
          !has(r.alias.quote, r.alias.term) ||
          !has(r.alias.quote, r.counterparty)
        : !has(r.quote, r.counterparty),
    )
    expect(missing.map((r) => `${r.ticker} ${r.counterparty}`)).toEqual([])
  })

  it('reads only SEC documents, each company-counterparty-relation once per document', () => {
    expect(table.rows.filter((r) => new URL(r.source_url).hostname !== 'www.sec.gov')).toEqual([])
    const keys = table.rows.map(
      (r) => `${r.ticker}|${r.relation}|${r.counterparty}|${r.source_url}|${r.figures[0]?.unit}`,
    )
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([])
  })

  it('files a company under one layer', () => {
    const layers = new Map<string, Set<string>>()
    for (const r of table.rows)
      layers.set(r.ticker, (layers.get(r.ticker) ?? new Set()).add(r.layer))
    expect([...layers].filter(([, l]) => l.size > 1).map(([t]) => t)).toEqual([])
  })
})

describe('quote matching', () => {
  it('reads a page as text and ignores what a copy changes', () => {
    const html =
      '<p>Customer&nbsp;A accounted for <ix:nonFraction>23</ix:nonFraction>% of revenue &#8212; the company&rsquo;s largest.</p><script>var x = "revenue"</script>'
    const text = comparable(pageText(html))
    expect(text).toContain(
      comparable('Customer A accounted for 23% of revenue - the company’s largest.'),
    )
    expect(text).not.toContain('varx')
    expect(text).not.toContain(comparable('accounted for 32% of revenue'))
  })
})
