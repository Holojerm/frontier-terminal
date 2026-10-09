// Quarterly revenue from SEC EDGAR company facts (XBRL), one recipe per
// filer. Companies tag revenue differently, so the extractor takes the
// newest of three common tags. 10-Ks report the year, not the fourth
// quarter, so Q4 is derived as the year less its three reported quarters
// and marked derived. A restated period keeps the latest filing's value.

import type { CompanyId } from '#shared/utils/companies'

import type { Observation, Recipe } from './contract'

const TAGS = [
  'RevenueFromContractWithCustomerExcludingAssessedTax',
  'RevenueFromContractWithCustomerIncludingAssessedTax',
  'Revenues',
] as const

interface Fact {
  start?: string
  end: string
  val: number
  form: string
  filed: string
  accn: string
}

const days = (start: string, end: string) => (Date.parse(end) - Date.parse(start)) / 86_400_000

/** Latest-filed fact per end date among facts lasting `min`–`max` days. */
function byEnd(facts: readonly Fact[], min: number, max: number): Map<string, Fact> {
  const out = new Map<string, Fact>()
  for (const f of facts) {
    if (!f.start) continue
    const d = days(f.start, f.end)
    if (d < min || d > max) continue
    const seen = out.get(f.end)
    if (!seen || f.filed > seen.filed) out.set(f.end, f)
  }
  return out
}

export function extractQuarterlyRevenue(body: string): Observation[] {
  const doc = JSON.parse(body) as {
    facts?: { 'us-gaap'?: Record<string, { units?: { USD?: Fact[] } }> }
  }
  const gaap = doc.facts?.['us-gaap'] ?? {}
  const candidates = TAGS.map((tag) => ({ tag, facts: gaap[tag]?.units?.USD ?? [] })).filter(
    (c) => c.facts.length > 0,
  )
  if (candidates.length === 0) throw new Error('no revenue tag in company facts')
  const newest = (c: (typeof candidates)[number]) =>
    c.facts.reduce((m, f) => (f.end > m ? f.end : m), '')
  const { tag, facts } = candidates.reduce((best, c) => (newest(c) > newest(best) ? c : best))

  const quarters = byEnd(facts, 80, 100)
  const out: Observation[] = [...quarters.values()].map((f) => ({
    key: 'revenue',
    date: f.end,
    value: f.val,
    payload: {
      tag,
      start: f.start,
      end: f.end,
      form: f.form,
      filed: f.filed,
      accn: f.accn,
      derived: false,
    },
  }))
  for (const year of byEnd(facts, 350, 380).values()) {
    if (quarters.has(year.end)) continue
    const inside = [...quarters.values()].filter((q) => q.start! >= year.start! && q.end < year.end)
    if (inside.length !== 3) continue
    const last = inside.reduce((m, q) => (q.end > m.end ? q : m))
    out.push({
      key: 'revenue',
      date: year.end,
      value: year.val - inside.reduce((n, q) => n + q.val, 0),
      payload: {
        tag,
        start: last.end,
        end: year.end,
        form: year.form,
        filed: year.filed,
        accn: year.accn,
        derived: true,
      },
    })
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1))
}

function secRevenue(id: string, company: CompanyId, cik: string, name: string): Recipe {
  return {
    id,
    company,
    description: `${name} quarterly revenue, from SEC EDGAR company facts (CIK ${cik})`,
    url: () => `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`,
    ext: 'json',
    extract: extractQuarterlyRevenue,
  }
}

export const SEC_REVENUE_NET = secRevenue(
  'sec-revenue-net',
  'cloudflare',
  '0001477333',
  'Cloudflare',
)
export const SEC_REVENUE_AKAM = secRevenue('sec-revenue-akam', 'akamai', '0001086222', 'Akamai')
export const SEC_REVENUE_FSLY = secRevenue('sec-revenue-fsly', 'fastly', '0001517413', 'Fastly')
