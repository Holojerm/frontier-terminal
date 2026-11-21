// The earnings filings on EDGAR a call goes with: each 8-K with item 2.02, or
// for a foreign private issuer each 6-K, and the EX-99 exhibits on its index
// page (the release, a CFO commentary, a shareholder letter, a deck). Pure.

const archive = (cik: string, accession: string) =>
  `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, '')}/`

/** Earnings filings filed before this aren't read: about a year of calls back from the first run. */
export const CALLS_SINCE = '2025-10-01'

export interface EarningsFiling {
  accession_no: string
  form: '8-K' | '6-K'
  filed: string
  index_url: string
}

/** Every earnings 8-K (item 2.02) and every 6-K in a submissions feed since `since`, oldest first. */
export function earningsFilings(body: string, cik: string, since: string): EarningsFiling[] {
  const doc = JSON.parse(body) as {
    cik?: string
    filings?: {
      recent?: { form: string[]; accessionNumber: string[]; filingDate: string[]; items?: string[] }
    }
  }
  const r = doc.filings?.recent
  if (!r) throw new Error('not an EDGAR submissions feed')
  if (Number(doc.cik) !== Number(cik)) throw new Error(`submissions feed is for CIK ${doc.cik}`)
  const out: EarningsFiling[] = []
  for (let i = 0; i < r.form.length; i++) {
    const form = r.form[i]
    const filed = r.filingDate[i]!
    if (filed < since) continue
    const earnings =
      (form === '8-K' && (r.items?.[i] ?? '').split(',').includes('2.02')) || form === '6-K'
    if (!earnings) continue
    const accession_no = r.accessionNumber[i]!
    out.push({
      accession_no,
      form: form as '8-K' | '6-K',
      filed,
      index_url: `${archive(cik, accession_no)}${accession_no}-index.html`,
    })
  }
  return out.sort((a, b) => a.filed.localeCompare(b.filed))
}

export interface Exhibit {
  type: string
  description: string
  url: string
}

// A 6-K that is a monthly revenue report, a buyback tally or a notice isn't an earnings filing.
const NOT_EARNINGS =
  /monthly revenue|revenue report|buy-?back|repurchase|notice|proxy|dividend|board|meeting|AGM/i
const EARNINGS =
  /result|earning|quarter|letter|outlook|guidance|management report|commentary|release|presentation|financial/i

/**
 * The EX-99 exhibits on a filing's index page. The page must be the index of
 * `accession`, or it throws. For a 6-K only exhibits that read as earnings
 * material are kept.
 */
export function earningsExhibits(
  indexHtml: string,
  cik: string,
  accession: string,
  form: '8-K' | '6-K',
): Exhibit[] {
  if (!indexHtml.includes(accession)) {
    throw new Error(`index page does not name accession ${accession}`)
  }
  const base = archive(cik, accession)
  const out: Exhibit[] = []
  for (const row of indexHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...row[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((c) =>
      c[1]!.replace(/<[^>]+>/g, '').trim(),
    )
    const type = cells.find((c) => /^EX-99/.test(c))
    if (!type) continue
    const name = /href="[^"]*\/([\w.-]+\.html?)"/.exec(row[1]!)?.[1]
    if (!name) continue
    const description = cells[1] ?? ''
    if (
      form === '6-K' &&
      (NOT_EARNINGS.test(description) || !EARNINGS.test(`${description} ${name}`))
    )
      continue
    out.push({ type, description, url: `${base}${name}` })
  }
  return out
}
