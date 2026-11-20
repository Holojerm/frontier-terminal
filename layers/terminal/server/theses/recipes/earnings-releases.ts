// One sentence a company prints in its quarterly earnings release (the
// EX-99.1 of an Item 2.02 8-K) and tags nowhere: Alphabet's API tokens per
// minute, CoreWeave's active power. EDGAR full-text search finds the releases
// that use the phrase, so one hop reaches the exhibit itself and the stored
// source URL is the document the sentence was read from.
//
// A run reads one release. The first run reads the oldest; each later run
// reads the one after the newest stored quarter, so the history fills one
// release per run and then waits on the newest. A quarter whose release
// drops the phrase is not in the search answer: the series ends at the last
// quarter that printed it, and the view shows that quarter's date.
//
// The wording changes every quarter ("nearly 32 billion", "Surpassed 1 GW"),
// so the sentence is stored verbatim beside the number and the qualifier is
// kept. A sentence the reader cannot place fails the run.

import type { CompanyId } from '../../../shared/utils/companies'

import { decodeEntities } from '../../pipeline/parsers/disclosures/html-text'
import type { Observation, Recipe } from './contract'

interface SearchHit {
  _id?: string
  _source?: { file_date?: string; file_type?: string; items?: string[] }
}

/**
 * The release to read. With nothing stored, the oldest. Otherwise the
 * releases filed after the newest stored quarter's end are that quarter's own
 * and then any later one: the later one when it exists, else the stored one
 * again (an unchanged run).
 */
export function releaseUrl(body: string, cik: string, newest: string | null): string {
  const doc = JSON.parse(body) as { hits?: { hits?: SearchHit[] } }
  if (!Array.isArray(doc.hits?.hits)) throw new Error('not an EDGAR full-text search answer')
  const releases = doc.hits.hits
    .filter((h) => h._source?.file_type === 'EX-99.1' && h._source.items?.includes('2.02'))
    .map((h) => ({ id: h._id ?? '', filed: h._source?.file_date ?? '' }))
    .filter((h) => /^\d{10}-\d{2}-\d{6}:[\w.-]+$/.test(h.id) && /^\d{4}-\d{2}-\d{2}$/.test(h.filed))
    .sort((a, b) => (a.filed < b.filed ? -1 : a.filed > b.filed ? 1 : 0))
  const after = newest === null ? [] : releases.filter((r) => r.filed > newest)
  const next = newest === null ? releases[0] : (after[1] ?? after[0] ?? releases.at(-1))
  if (!next) throw new Error('no earnings release in the search answer')
  const [accession, name] = next.id.split(':') as [string, string]
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll('-', '')}/${name}`
}

/** The release as running text: tags dropped, entities decoded, whitespace collapsed. */
export function releaseText(html: string): string {
  if (!/<(?:html|document|body)\b/i.test(html)) throw new Error('not an HTML document')
  return decodeEntities(
    html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

const QUARTER_END: Readonly<Record<string, string>> = {
  first: '03-31',
  second: '06-30',
  third: '09-30',
  fourth: '12-31',
}

/** The quarter a release reports, from its title ("… Third Quarter 2026 Results"). Both filers use calendar years. */
export function quarterOf(text: string): { date: string; label: string } {
  const m = /\b(First|Second|Third|Fourth) Quarter(?: and (?:Fiscal|Full) Year)? (\d{4})\b/.exec(
    text.slice(0, 600),
  )
  if (!m) throw new Error('no quarter in the release title')
  const n = ['first', 'second', 'third', 'fourth'].indexOf(m[1]!.toLowerCase()) + 1
  return { date: `${m[2]}-${QUARTER_END[m[1]!.toLowerCase()]}`, label: `Q${n} ${m[2]}` }
}

const QUALIFIER = /\b(nearly|almost|approximately|about|over|more than|surpassed|at least)\s*$/i

const qualifierBefore = (text: string): string | null =>
  QUALIFIER.exec(text)?.[1]?.toLowerCase() ?? null

/** Alphabet: "… processing nearly 32 billion tokens per minute …", one observation per release. */
export function extractApiTokens(html: string): Observation[] {
  const text = releaseText(html)
  const quarter = quarterOf(text)
  const m = /(\d+(?:\.\d+)?) (billion|trillion) (?:API )?tokens per minute/.exec(text)
  if (!m) throw new Error('no "tokens per minute" figure in the release')
  const start = Math.max(text.lastIndexOf('. ', m.index) + 2, 0)
  const end = text.indexOf('. ', m.index)
  return [
    {
      key: 'api_tokens_per_minute',
      date: quarter.date,
      value: Number(m[1]) * (m[2] === 'trillion' ? 1e12 : 1e9),
      payload: {
        quarter: quarter.label,
        qualifier: qualifierBefore(text.slice(0, m.index)),
        sentence: text.slice(start, end === -1 ? undefined : end + 1),
      },
    },
  ]
}

const POWER = String.raw`((?:nearly|almost|approximately|about|over|more than|surpassed|at least)\s+)?(\d+(?:[.,]\d+)?)\s*(MW|GW)s?`
const TOTAL_AFTER = new RegExp(String.raw`(?:to reach|bringing the total to)\s+${POWER}`, 'i')
const TOTAL_BEFORE = new RegExp(String.raw`${POWER}\s+of active power`, 'i')
// Guidance and forward-looking boilerplate use the same words about a later date.
const FORWARD = /\b(expect|believe|year-end|projections?|guidance|outlook|statements related to)\b/i

/**
 * CoreWeave: active power at the quarter's end, in MW. The total is the
 * figure after "to reach" or "bringing the total to" when the sentence adds
 * to a running total, otherwise the figure in front of "of active power".
 */
export function extractActivePower(html: string): Observation[] {
  const text = releaseText(html)
  const quarter = quarterOf(text)
  const segments = text.split(/\s[•◦]\s|(?<=[a-z)”"])\.\s+(?=[A-Z“"])/)
  const sentence = segments.find((s) => /active power/i.test(s) && !FORWARD.test(s))
  if (!sentence) throw new Error('no "active power" sentence in the release')
  const m = TOTAL_AFTER.exec(sentence) ?? TOTAL_BEFORE.exec(sentence)
  if (!m) throw new Error(`no active power total in: ${sentence.slice(0, 160)}`)
  const n = Number(m[2]!.replace(',', ''))
  return [
    {
      key: 'active_power_mw',
      date: quarter.date,
      value: m[3]!.toUpperCase() === 'GW' ? n * 1000 : n,
      payload: {
        quarter: quarter.label,
        qualifier: m[1]?.trim().toLowerCase() ?? null,
        sentence: sentence.trim(),
      },
    },
  ]
}

function earningsRelease(opts: {
  id: string
  company: CompanyId
  cik: string
  phrase: string
  description: string
  extract: (html: string) => Observation[]
}): Recipe {
  return {
    id: opts.id,
    company: opts.company,
    description: opts.description,
    url: () =>
      `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(`"${opts.phrase}"`)}&ciks=${opts.cik}&forms=8-K`,
    ext: 'html',
    follow: (body, ctx) => releaseUrl(body, opts.cik, ctx.newest),
    extract: (body) => opts.extract(body),
  }
}

export const SEC_GOOGL_API_TOKENS = earningsRelease({
  id: 'sec-googl-api-tokens',
  company: 'google',
  cik: '0001652044',
  phrase: 'tokens per minute',
  description:
    'Alphabet earnings releases: tokens per minute through its first-party model APIs, as stated each quarter',
  extract: extractApiTokens,
})

export const SEC_CRWV_ACTIVE_POWER = earningsRelease({
  id: 'sec-crwv-active-power',
  company: 'coreweave',
  cik: '0001769628',
  phrase: 'active power',
  description: 'CoreWeave earnings releases: active power at the end of each quarter, in MW',
  extract: extractActivePower,
})

export const EARNINGS_RELEASE_RECIPES: readonly Recipe[] = [
  SEC_GOOGL_API_TOKENS,
  SEC_CRWV_ACTIVE_POWER,
]
