// Capex guidance as an earnings release prints it. A filer furnishes the
// release as exhibit 99.1 of an 8-K with item 2.02, and some releases state
// what the filer expects to spend on capex in a fiscal year, as one figure or
// a range. This reads that sentence and nothing else.
//
// A sentence is taken when it names capital expenditures, says expect or
// anticipate, names a year, and states an amount in billions of dollars. The
// amount is the first one after the words "capital expenditures", or the last
// one before them when none follows ("invest about $200 billion in capital
// expenditures"). A release with no such sentence yields nothing: guidance
// given only on the call isn't in the release; layers/terminal/server/calls/ reads the calls.
//
// Pure, and dependency-free like facts.ts.

/** Releases filed before this aren't read. */
export const GUIDANCE_SINCE = '2024-01-01'

/** One 8-K that furnished an earnings release. */
export interface ReleaseDocument {
  accession_no: string
  filed: string
  /** EDGAR's index page for the filing, which lists its exhibits by type. */
  index_url: string
}

const archive = (cik: string, accession: string) =>
  `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, '')}/`

/** Every 8-K with item 2.02 in a submissions feed filed on or after `since`, newest first. */
export function releaseDocuments(body: string, cik: string, since: string): ReleaseDocument[] {
  const doc = JSON.parse(body) as {
    cik?: string
    filings?: {
      recent?: {
        form: string[]
        accessionNumber: string[]
        filingDate: string[]
        items?: string[]
      }
    }
  }
  const r = doc.filings?.recent
  if (!r) throw new Error('not an EDGAR submissions feed')
  if (Number(doc.cik) !== Number(cik)) throw new Error(`submissions feed is for CIK ${doc.cik}`)
  const out: ReleaseDocument[] = []
  for (let i = 0; i < r.form.length; i++) {
    const filed = r.filingDate[i]!
    if (r.form[i] !== '8-K' || filed < since) continue
    if (!(r.items?.[i] ?? '').split(',').includes('2.02')) continue
    const accession_no = r.accessionNumber[i]!
    out.push({
      accession_no,
      filed,
      index_url: `${archive(cik, accession_no)}${accession_no}-index.html`,
    })
  }
  return out.sort((a, b) => (a.filed < b.filed ? 1 : a.filed > b.filed ? -1 : 0))
}

/**
 * The URL of exhibit 99.1 on a filing's index page, or null when the filing
 * lists none. The page must be the index of `accession`, or it throws: a wrong
 * page must fail the read, not attach another filing's release.
 */
export function exhibitUrl(indexHtml: string, cik: string, accession: string): string | null {
  if (!indexHtml.includes(accession)) {
    throw new Error(`index page does not name accession ${accession}`)
  }
  const base = archive(cik, accession)
  for (const row of indexHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...row[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((c) =>
      c[1]!.replace(/<[^>]+>/g, '').trim(),
    )
    if (!cells.includes('EX-99.1')) continue
    const name = /href="[^"]*\/([\w.-]+\.htm)"/.exec(row[1]!)?.[1]
    if (name) return `${base}${name}`
  }
  return null
}

const ENTITIES: Readonly<Record<string, string>> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: '’',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  ndash: '–',
  mdash: '—',
}

const decode = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole)

/** A release's text, one string per block element, whitespace collapsed. */
export function releaseBlocks(html: string): string[] {
  return decode(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/?(?:p|div|td|th|tr|li|h[1-6]|table|br)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((line) => line.replace(/[\s ]+/g, ' ').trim())
    .filter(Boolean)
}

/** One capex figure a release prints for a fiscal year. */
export interface GuidanceInput {
  /** The year the release names. For a fiscal year that isn't the calendar year, the year it ends in. */
  fiscal_year: number
  /** In US dollars. Equal to `high` for a single figure. */
  low: number
  high: number
  /** The release's sentence, entities decoded and whitespace collapsed. */
  sentence: string
}

const CAPEX = /\bcapital expenditures\b|\bcap\s?ex\b/i
const FORWARD = /\b(?:expect|anticipate)(?:s|d|ed)?\b/i
const AMOUNT =
  /\$\s?(\d+(?:\.\d+)?)(?:\s?billion)?\s?(?:-|–|—|to)\s?\$?\s?(\d+(?:\.\d+)?)\s?billion|\$\s?(\d+(?:\.\d+)?)\s?billion/gi

function amountsIn(text: string): { at: number; low: number; high: number }[] {
  return [...text.matchAll(AMOUNT)].map((m) => {
    const low = Number(m[1] ?? m[3]) * 1e9
    const high = Number(m[2] ?? m[3]) * 1e9
    return { at: m.index, low, high }
  })
}

/** The guidance in one sentence, or null. */
export function guidanceIn(sentence: string): GuidanceInput | null {
  const term = CAPEX.exec(sentence)
  if (!term || !FORWARD.test(sentence)) return null
  const years = [...sentence.matchAll(/\b(20\d\d)\b/g)]
  if (years.length === 0) return null
  const amounts = amountsIn(sentence)
  const after = term.index + term[0].length
  const amount = amounts.find((a) => a.at >= after) ?? amounts.findLast((a) => a.at < term.index)
  if (!amount || amount.high < amount.low) return null
  // The year nearest the words: "2026 capital expenditures", "capital expenditures across Amazon in 2026".
  const year = years.reduce((a, b) =>
    Math.abs(b.index - term.index) < Math.abs(a.index - term.index) ? b : a,
  )
  return { fiscal_year: Number(year[1]), low: amount.low, high: amount.high, sentence }
}

/** Every fiscal year a release prints a capex figure for, at the first sentence that states it. */
export function extractGuidance(html: string): GuidanceInput[] {
  const out = new Map<number, GuidanceInput>()
  for (const block of releaseBlocks(html)) {
    if (!CAPEX.test(block)) continue
    for (const sentence of block.split(/(?<=[.!?])\s+(?=[A-Z“"])/)) {
      // A list item's bullet isn't part of the sentence, nor is the quote mark
      // of the remark it opens or closes.
      const found = guidanceIn(sentence.replace(/^[\s•·▪●“"]+|[\s”"]+$/g, ''))
      if (found && !out.has(found.fiscal_year)) out.set(found.fiscal_year, found)
    }
  }
  return [...out.values()].sort((a, b) => a.fiscal_year - b.fiscal_year)
}
