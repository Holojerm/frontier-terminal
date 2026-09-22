import {
  registerParser,
  EdgarCompanyfactsOutput,
  type ParserId,
  type Provenance,
  type RevenueRow,
} from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'
import { parseCikWhitelistBlock, whitelistCikFor, type CikWhitelist } from './whitelist'

// edgar-companyfacts-<ticker> — data.sec.gov/api/xbrl/companyfacts/CIK{n}.json:
// every XBRL fact a filer has ever tagged, by taxonomy and tag. This parser
// reads the revenue tags only, in a fixed order, and emits one RevenueRow
// per duration fact (start + end) in USD. Instant facts (balances) and
// other units are not revenue and are skipped.
//
// The value is the filer's own number, unscaled. Nothing is derived here:
// no quarter is computed from two half-years, no annual from four quarters.
// Which tag a period is read from is the reader's decision
// (server/utils/terminal-revenue.ts), so every tag present is stored.

/** Revenue tags in the order a reader should prefer them. Filers switched
 * from Revenues / SalesRevenueNet to the ASC 606 tag around 2018 and some
 * still tag both. */
export const REVENUE_TAGS: readonly string[] = [
  'Revenues',
  'RevenueFromContractWithCustomerExcludingAssessedTax',
  'SalesRevenueNet',
]

interface Fact {
  start?: string
  end: string
  val: number
  accn: string
  fy: number | null
  fp: string | null
  form: string
  filed: string
  frame?: string
}

interface CompanyfactsDoc {
  cik: string | number
  entityName: string
  facts: Record<string, Record<string, { units: Record<string, Fact[]> }>>
}

export function parseEdgarCompanyfacts(
  text: string,
  whitelist: CikWhitelist,
  prov: Provenance,
): { rows: RevenueRow[]; tags: string[] } {
  const doc = JSON.parse(text) as CompanyfactsDoc
  const cik = String(doc.cik).padStart(10, '0')
  const whitelistCik = whitelistCikFor([cik], whitelist)
  const gaap = doc.facts['us-gaap'] ?? {}

  const rows: RevenueRow[] = []
  const tags: string[] = []
  const seen = new Set<string>()
  for (const tag of REVENUE_TAGS) {
    const facts = gaap[tag]?.units?.USD
    if (!facts) continue
    tags.push(tag)
    for (const f of facts) {
      if (!f.start) continue // an instant fact is a balance, not a period's revenue
      const key = `${tag}\n${f.accn}\n${f.start}\n${f.end}`
      if (seen.has(key)) continue
      seen.add(key)
      rows.push({
        cik,
        entity_name: doc.entityName,
        taxonomy: 'us-gaap',
        tag,
        unit: 'USD',
        start: f.start,
        end: f.end,
        val: f.val,
        accession_no: f.accn,
        fy: f.fy ?? null,
        fp: f.fp ?? null,
        form: f.form,
        filed: f.filed,
        frame: f.frame ?? null,
        whitelist_cik: whitelistCik,
        ...prov,
      })
    }
  }

  rows.sort((a, b) => {
    const ka = `${a.tag}|${a.accession_no}|${a.start}|${a.end}`
    const kb = `${b.tag}|${b.accession_no}|${b.start}|${b.end}`
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
  return { rows: EdgarCompanyfactsOutput.parse({ rows }).rows, tags }
}

/** The companyfacts feeds: source id -> committed fixture. One per tagged revenue filer. */
export const COMPANYFACTS_SOURCES: Readonly<Record<string, string>> = {
  'edgar-companyfacts-spcx': 'fixtures/sec/edgar-companyfacts-spcx.json',
}

for (const [sourceId, fixturePath] of Object.entries(COMPANYFACTS_SOURCES)) {
  registerParser({
    name: sourceId as ParserId,
    lane: 'sec',
    fixturePath,
    sideFixturePaths: ['sources.yaml'],
    schema: EdgarCompanyfactsOutput,
    parse: (text, side) =>
      EdgarCompanyfactsOutput.parse({
        rows: parseEdgarCompanyfacts(
          text,
          parseCikWhitelistBlock(side('sources.yaml')),
          fixtureProvenance(sourceId),
        ).rows,
      }),
  })
}
