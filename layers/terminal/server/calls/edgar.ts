// The earnings filings on EDGAR a call goes with: each 8-K with item 2.02, or
// for a foreign private issuer each 6-K, and the EX-99 exhibits on its index
// page (the release, a CFO commentary, a shareholder letter, a deck). Pure.
//
// A submissions feed lists a filer's last thousand or so filings under
// `recent`; older ones sit in the paged files it names under `files`, each
// with the same columns. A page that ends before BACKFILL_SINCE isn't read.

const archive = (cik: string, accession: string) =>
  `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, '')}/`

/** Earnings filings filed before this aren't read (owner's backfill, 2026-11-21). */
export const BACKFILL_SINCE = '2018-01-01'

export interface EarningsFiling {
  accession_no: string
  form: '8-K' | '6-K'
  filed: string
  index_url: string
}

interface FeedColumns {
  form: string[]
  accessionNumber: string[]
  filingDate: string[]
  items?: string[]
}

interface SubmissionsFeed {
  cik?: string
  filings?: {
    recent?: FeedColumns
    files?: { name: string; filingFrom: string; filingTo: string }[]
  }
}

function parseFeed(
  body: string,
  cik: string,
): SubmissionsFeed & { filings: { recent: FeedColumns } } {
  const doc = JSON.parse(body) as SubmissionsFeed
  if (!doc.filings?.recent) throw new Error('not an EDGAR submissions feed')
  if (Number(doc.cik) !== Number(cik)) throw new Error(`submissions feed is for CIK ${doc.cik}`)
  return doc as SubmissionsFeed & { filings: { recent: FeedColumns } }
}

function filingsOf(r: FeedColumns, cik: string, since: string): EarningsFiling[] {
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

/** Every earnings 8-K (item 2.02) and every 6-K in a submissions feed's `recent` since `since`, oldest first. */
export function earningsFilings(body: string, cik: string, since: string): EarningsFiling[] {
  return filingsOf(parseFeed(body, cik).filings.recent, cik, since)
}

/** The paged files of a submissions feed that hold filings since `since`, as URLs. */
export function olderPages(body: string, cik: string, since: string): string[] {
  return (parseFeed(body, cik).filings.files ?? [])
    .filter((p) => p.filingTo >= since && /^CIK\d{10}-submissions-\d{3}\.json$/.test(p.name))
    .map((p) => `https://data.sec.gov/submissions/${p.name}`)
}

/** The earnings filings in one paged file (CIK…-submissions-001.json), which has no `cik` of its own. */
export function pageFilings(body: string, cik: string, since: string): EarningsFiling[] {
  const r = JSON.parse(body) as Partial<FeedColumns>
  if (
    !Array.isArray(r.form) ||
    !Array.isArray(r.accessionNumber) ||
    !Array.isArray(r.filingDate) ||
    r.form.length !== r.accessionNumber.length
  )
    throw new Error('not an EDGAR submissions page')
  return filingsOf(r as FeedColumns, cik, since)
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
 * material are kept; `skip` drops a subsidiary's own release filed under the
 * parent (DTE Gas's under DTE Energy).
 */
export function earningsExhibits(
  indexHtml: string,
  cik: string,
  accession: string,
  form: '8-K' | '6-K',
  skip?: RegExp,
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
    if (skip?.test(`${name} ${description}`)) continue
    // A description that only repeats the type ("EX-99.1", as TSMC's said until 2023) says nothing either way.
    const bare = /^(?:EX-99[\d.]*|exhibit\s*99[\d.]*)?$/i.test(description)
    if (
      form === '6-K' &&
      (NOT_EARNINGS.test(`${description} ${name}`) ||
        (!bare && !EARNINGS.test(`${description} ${name}`)))
    )
      continue
    out.push({ type, description, url: `${base}${name}` })
  }
  return out
}
