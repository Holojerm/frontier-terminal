// The suppliers table: chip, hardware and compute-rental companies whose own SEC
// filings tie them to a lab or a cloud, from the hand-read file
// (../curated/suppliers.json) plus what the judge reads (../suppliers/).

import { currentPassages, rowOf } from '../suppliers/store'

export const SUPPLIERS_RULE =
  'Each row is one passage from the company’s own SEC filing, quoted. The first rows were read by hand; each new 10-Q, 10-K, 8-K, 20-F or 6-K is read by a model and kept only where the quote and every figure in it are in the filing word for word. A passage a later filing of the same form no longer has is dropped. A share is the filing’s own figure for one customer in the period it names, and companies’ fiscal years differ. Where a filing gives a customer’s share and no name, the row keeps the filing’s label and names no one. Not investment advice.'

/**
 * The share a row puts on its customer: the first figure, which is the
 * filing's newest period. A share for several customers together counts only
 * where the row has no single customer's share.
 */
const shareOf = (row: SupplierRow): SupplierShare | null => {
  const f =
    row.figures.find((x) => x.unit === 'pct_revenue') ??
    row.figures.find((x) => x.unit === 'pct_revenue_combined')
  return f
    ? {
        pct: f.value,
        counterparty: row.counterparty,
        meaning: f.meaning,
        filed: row.filed,
        combined: f.unit === 'pct_revenue_combined',
      }
    : null
}

/**
 * The share from the newer document, and the larger of two in the same one.
 * A 10-K's year and a later 10-Q's quarter are both kept as rows. The company
 * line shows the newest, so a quarter's share is never set beside a year's.
 */
const newest = (a: SupplierShare | null, b: SupplierShare | null) => {
  if (!a || !b) return a ?? b
  if (b.filed !== a.filed) return b.filed > a.filed ? b : a
  if (b.combined !== a.combined) return a.combined ? b : a
  return b.pct > a.pct ? b : a
}

export function buildSuppliers(table: { rows: readonly SupplierRow[] }): SuppliersData {
  const companies = new Map<string, SupplierCompany>()
  for (const row of table.rows) {
    const c = companies.get(row.ticker) ?? {
      ticker: row.ticker,
      company: row.company,
      layer: row.layer,
      named: [],
      labs: [],
      top_named_share: null,
      top_unnamed_share: null,
      rows: 0,
    }
    c.rows += 1
    const share = shareOf(row)
    if (row.relation === 'concentration') {
      c.top_unnamed_share = newest(c.top_unnamed_share, share)
    } else {
      if (!c.named.some((n) => n.name === row.counterparty)) {
        c.named.push({
          name: row.counterparty,
          ticker: row.counterparty_ticker,
          lab: row.counterparty_lab,
        })
      }
      if (row.counterparty_lab && !c.labs.includes(row.counterparty_lab)) {
        c.labs.push(row.counterparty_lab)
      }
      // Only a customer's share is the company's dependence on it.
      if (row.relation === 'customer') c.top_named_share = newest(c.top_named_share, share)
    }
    companies.set(row.ticker, c)
  }

  // A share for several customers together is no one customer's, so it ranks last.
  const single = (s: SupplierShare | null) => (s && !s.combined ? s.pct : 0)
  const top = (c: SupplierCompany) =>
    Math.max(single(c.top_named_share), single(c.top_unnamed_share))
  const ordered = [...companies.values()].sort(
    (a, b) => top(b) - top(a) || a.ticker.localeCompare(b.ticker),
  )
  const rank = new Map(ordered.map((c, i) => [c.ticker, i]))
  const rows = table.rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => rank.get(a.row.ticker)! - rank.get(b.row.ticker)! || a.i - b.i)
    .map(({ row }) => row)

  const unnamed = table.rows.filter((r) => r.relation === 'concentration').length
  const gaps: SupplierGap[] = []
  if (unnamed) {
    gaps.push({
      id: 'unnamed-customers',
      title: 'Customers a filing doesn’t name stay unnamed',
      reason: `${unnamed} ${unnamed === 1 ? 'row gives' : 'rows give'} a share for a customer under a label like “Customer A”. The filing doesn’t say who it is, so the row doesn’t either, and it is tied to no lab or cloud.`,
    })
  }
  gaps.push(
    {
      id: 'not-on-graph',
      title: 'These companies aren’t circles on the graph',
      reason:
        'The graph draws figures a filer tags in its XBRL on a named counterparty. These rows are quoted sentences, with shares and dollars that measure different things, so they are listed here with their quotes.',
    },
    {
      id: 'unfiled-deals',
      title: 'Announced deals with no filed passage aren’t listed',
      reason:
        'A row needs a passage in the company’s own SEC document. A deal known only from a press report or a lab’s blog post isn’t here.',
    },
    {
      id: 'exhibits-unread',
      title: 'An exhibit to an 8-K or 6-K isn’t read',
      reason:
        'The reader reads the main document of each new filing. A tie stated only in an attached press release or interim statements reaches the table when it is read by hand.',
    },
    {
      id: 'non-sec-suppliers',
      title: 'Suppliers that don’t file with the SEC aren’t read',
      reason:
        'Memory makers, server builders and foundries listed only in Korea, Taiwan or Japan publish no SEC document to quote.',
    },
  )

  return {
    as_of: table.rows.reduce<string | null>(
      (m, r) => (m === null || r.fetched_at < m ? r.fetched_at : m),
      null,
    ),
    rule: SUPPLIERS_RULE,
    companies: ordered,
    rows,
    gaps,
  }
}

/** The rows no later filing has dropped, as a reader sees them. */
export async function querySuppliers(db: PipelineDb): Promise<SuppliersData> {
  return buildSuppliers({ rows: (await currentPassages(db)).map(rowOf) })
}
