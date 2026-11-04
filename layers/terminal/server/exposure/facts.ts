// Reading filed XBRL facts out of the two documents EDGAR serves them in.
//
// Company facts (data.sec.gov/api/xbrl/companyfacts) carry every
// non-dimensional fact a filer ever tagged, once per filing that reported it,
// with the accession and filing date. That is the whole history of a capex or
// a total-RPO line in one request. It drops every fact whose context names a
// dimension, so a segment's backlog or a line tagged on an investee member
// (msft:OpenAIGlobalLlcMember) is only in each filing's own instance file,
// which the second reader parses.
//
// Both are pure and throw on a shape they do not recognise: a source that
// cannot be read is a failed read, never an empty one.

/** One fact as a filing reported it, before the filer's ticker and CIK are attached. */
export interface FactInput {
  /** Prefixed concept, e.g. us-gaap:PaymentsToAcquirePropertyPlantAndEquipment. */
  concept: string
  /** `axis=member` pairs, sorted and joined with `;`; '' for none. A typed member's value stands in for the member. */
  dims: string
  start: string | null
  end: string
  value: number
  unit: string
  form: string
  filed: string
  accession_no: string
}

/** The non-dimensional concepts read from company facts: capex, finance leases, total backlog. */
export const COMPANYFACTS_CONCEPTS = [
  'PaymentsToAcquirePropertyPlantAndEquipment',
  'PaymentsToAcquireProductiveAssets',
  'FinanceLeasePrincipalPayments',
  'RightOfUseAssetObtainedInExchangeForFinanceLeaseLiability',
  'RevenueRemainingPerformanceObligation',
] as const

/** Facts ending before this are not kept: the first 2020 quarter derives from a 2019 year-to-date. */
export const FACTS_SINCE = '2019-01-01'

const PERIODIC = /^10-[QK](\/A)?$/

interface CompanyFact {
  start?: string
  end: string
  val: number
  accn: string
  form: string
  filed: string
}

export function extractCompanyfacts(body: string, cik: string): FactInput[] {
  const doc = JSON.parse(body) as {
    cik?: number | string
    facts?: { 'us-gaap'?: Record<string, { units?: Record<string, CompanyFact[]> }> }
  }
  if (!doc.facts) throw new Error('not an EDGAR company facts document')
  if (Number(doc.cik) !== Number(cik)) throw new Error(`company facts are for CIK ${doc.cik}`)
  const gaap = doc.facts['us-gaap'] ?? {}
  const out: FactInput[] = []
  let concepts = 0
  for (const tag of COMPANYFACTS_CONCEPTS) {
    const units = gaap[tag]?.units
    if (!units) continue
    concepts++
    for (const [unit, facts] of Object.entries(units)) {
      for (const f of facts) {
        if (!PERIODIC.test(f.form) || f.end < FACTS_SINCE || typeof f.val !== 'number') continue
        out.push({
          concept: `us-gaap:${tag}`,
          dims: '',
          start: f.start ?? null,
          end: f.end,
          value: f.val,
          unit,
          form: f.form,
          filed: f.filed,
          accession_no: f.accn,
        })
      }
    }
  }
  if (concepts === 0) throw new Error('no capex or backlog concept in us-gaap facts')
  return out
}

/** One 10-Q or 10-K whose instance file can be read. */
export interface InstanceDocument {
  accession_no: string
  form: '10-Q' | '10-K'
  filed: string
  url: string
}

/**
 * Every original 10-Q/10-K in a submissions feed filed on or after `since`,
 * newest first, with its instance URL: the primary document's name with
 * `.htm` replaced by `_htm.xml`, the file SEC extracts from an inline-XBRL
 * filing. Amendments are left out: an amendment's instance is named the same
 * way only some of the time.
 */
export function instanceDocuments(body: string, cik: string, since: string): InstanceDocument[] {
  const doc = JSON.parse(body) as {
    cik?: string
    filings?: {
      recent?: {
        form: string[]
        accessionNumber: string[]
        filingDate: string[]
        primaryDocument: string[]
      }
    }
  }
  const r = doc.filings?.recent
  if (!r) throw new Error('not an EDGAR submissions feed')
  if (Number(doc.cik) !== Number(cik)) throw new Error(`submissions feed is for CIK ${doc.cik}`)
  const out: InstanceDocument[] = []
  for (let i = 0; i < r.form.length; i++) {
    const form = r.form[i]
    const filed = r.filingDate[i]!
    const primary = r.primaryDocument[i]!
    if ((form !== '10-Q' && form !== '10-K') || filed < since) continue
    if (!/^[\w.-]+\.htm$/.test(primary)) continue
    const accession_no = r.accessionNumber[i]!
    out.push({
      accession_no,
      form,
      filed,
      url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession_no.replace(/-/g, '')}/${primary.replace(/\.htm$/, '_htm.xml')}`,
    })
  }
  return out.sort((a, b) => (a.filed < b.filed ? 1 : a.filed > b.filed ? -1 : 0))
}

interface Context {
  dims: [string, string][]
  start: string | null
  end: string
}

function contexts(xml: string): Map<string, Context> {
  const out = new Map<string, Context>()
  for (const m of xml.matchAll(
    /<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g,
  )) {
    const body = m[2]!
    const dims: [string, string][] = [
      ...body.matchAll(/<xbrldi:explicitMember\b[^>]*dimension="([^"]+)"[^>]*>\s*([^<\s]+)\s*</g),
    ].map((d) => [d[1]!, d[2]!])
    for (const t of body.matchAll(
      /<xbrldi:typedMember\b[^>]*dimension="([^"]+)"[^>]*>\s*<[^>]+>\s*([^<]*?)\s*<\//g,
    )) {
      dims.push([t[1]!, t[2]!])
    }
    const instant = /<(?:xbrli:)?instant>\s*([^<\s]+)\s*</.exec(body)?.[1]
    const start = /<(?:xbrli:)?startDate>\s*([^<\s]+)\s*</.exec(body)?.[1]
    const end = /<(?:xbrli:)?endDate>\s*([^<\s]+)\s*</.exec(body)?.[1]
    if (instant) out.set(m[1]!, { dims, start: null, end: instant })
    else if (start && end) out.set(m[1]!, { dims, start, end })
  }
  return out
}

/** unit id -> USD, shares, pure, or the measure as written (`iso4217:EUR`); a ratio unit -> `a/b`. */
function units(xml: string): Map<string, string> {
  const out = new Map<string, string>()
  const name = (measure: string) => {
    const m = measure.trim()
    if (/^iso4217:USD$/i.test(m)) return 'USD'
    if (/:shares$/.test(m)) return 'shares'
    if (/:pure$/.test(m)) return 'pure'
    return m
  }
  for (const u of xml.matchAll(
    /<(?:xbrli:)?unit\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?unit>/g,
  )) {
    const measures = [...u[2]!.matchAll(/<(?:xbrli:)?measure>([^<]+)</g)].map((x) => name(x[1]!))
    out.set(u[1]!, measures.join('/'))
  }
  return out
}

const dimsKey = (dims: readonly [string, string][]) =>
  dims
    .map(([axis, member]) => `${axis}=${member}`)
    .sort()
    .join(';')

const RPO = /^us-gaap:RevenueRemainingPerformanceObligation(AmountPeriodIncreaseDecrease)?$/

/** dei:<name>'s text in an instance, or null. */
function dei(xml: string, name: string): string | null {
  return new RegExp(`<dei:${name}\\b[^>]*>\\s*([^<]*?)\\s*<`).exec(xml)?.[1] ?? null
}

/**
 * The dimensional facts one 10-Q/10-K instance tags that company facts drop:
 * every numeric fact on one of `members` (on any axis), and every dollar RPO
 * fact whose context names a dimension (a segment, a customer, a timing
 * axis). The instance must name the filing it was derived for (its CIK and
 * form), or it throws: a wrong document must fail the read, not store
 * another company's numbers.
 */
export function extractInstanceFacts(
  xml: string,
  filing: { cik: string; form: string; filed: string; accession_no: string },
  members: readonly string[],
): FactInput[] {
  if (!/<(?:xbrli:)?xbrl\b/.test(xml)) throw new Error('not an XBRL instance')
  const cik = dei(xml, 'EntityCentralIndexKey')
  if (cik === null || Number(cik) !== Number(filing.cik)) {
    throw new Error(`instance names CIK ${cik}, not ${filing.cik}`)
  }
  const type = dei(xml, 'DocumentType')
  if (type !== filing.form) throw new Error(`instance is a ${type}, not a ${filing.form}`)
  const ctx = contexts(xml)
  const unitOf = units(xml)
  const out = new Map<string, FactInput>()
  for (const m of xml.matchAll(/<([\w-]+:\w+)\b([^>]*?)\bcontextRef="([^"]+)"([^>]*)>([^<]*)</g)) {
    const attrs = m[2]! + m[4]!
    if (attrs.trimEnd().endsWith('/') || /\bxsi:nil="true"/.test(attrs)) continue
    const unitRef = /\bunitRef="([^"]+)"/.exec(attrs)?.[1]
    const unit = unitRef ? unitOf.get(unitRef) : undefined
    const raw = m[5]!.trim()
    if (!unit || raw === '') continue
    const c = ctx.get(m[3]!)
    if (!c || c.dims.length === 0) continue
    const concept = m[1]!
    const onMember = c.dims.some(([, member]) => members.includes(member))
    if (!onMember && !(RPO.test(concept) && unit === 'USD')) continue
    const value = Number(raw)
    if (!Number.isFinite(value)) throw new Error(`${concept} on ${m[3]} is not a number: ${raw}`)
    const fact: FactInput = {
      concept,
      dims: dimsKey(c.dims),
      start: c.start,
      end: c.end,
      value,
      unit,
      form: filing.form,
      filed: filing.filed,
      accession_no: filing.accession_no,
    }
    out.set(`${concept}|${fact.dims}|${fact.start}|${fact.end}`, fact)
  }
  return [...out.values()]
}
