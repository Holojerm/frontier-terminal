// Search terms for an alert, built only from its cited change rows: the same
// rows always give the same query. `who` names the company and `what` the
// event; `also` narrows a broad `what` (a department name needs a hiring
// word beside it). GDELT gets every group as one boolean query, any phrase
// of each group required. A newsroom post is already the lab's own, so it is
// matched on `what` alone.
//
// Terms are deliberately broad. A candidate is not a match: the judge rates
// each one as the same event or not, so a broad term costs a rating, while a
// narrow one loses the article for good.

import type { ChangeRow } from '../contracts'

export interface SearchTerms {
  who: string[]
  what: string[]
  also: string[]
}

/** Names the press uses for each tracked lab (GDELT matching is case-insensitive). */
export const LAB_NAMES: Readonly<Record<string, readonly string[]>> = {
  openai: ['OpenAI', 'ChatGPT'],
  anthropic: ['Anthropic', 'Claude'],
  google: ['Google', 'Gemini', 'DeepMind'],
  xai: ['xAI', 'Grok'],
  meta: ['Meta', 'Llama'],
  mistral: ['Mistral'],
}

/** The press name for a whitelisted filer's CIK (sources.yaml cik_whitelist). */
export const FILER_NAMES: Readonly<Record<string, string>> = {
  '0000789019': 'Microsoft',
  '0001018724': 'Amazon',
  '0001045810': 'Nvidia',
  '0001181412': 'SpaceX',
  '0001652044': 'Alphabet',
  '0001326801': 'Meta',
  '0002130357': 'Anthropic',
}

const OUTAGE = ['outage', 'outages', 'elevated errors', 'disruption']
const MISALIGNMENT = ['misalignment', 'misaligned']
const HIRING = ['hiring', 'jobs', 'job cuts', 'layoffs', 'roles']
const IPO = ['IPO', 'initial public offering', 'S-1', 'prospectus']

/** What the press calls an SEC form's event. */
export function formTerms(form: string): string[] {
  const f = form.toUpperCase()
  if (/^(S-1|F-1|424B)/.test(f)) return IPO
  if (f.startsWith('10-Q')) return ['earnings', 'quarterly results', '10-Q']
  if (f.startsWith('10-K')) return ['earnings', 'annual report', '10-K']
  if (f.startsWith('8-K')) return ['8-K', 'filing']
  if (f === '4' || f === '4/A') return ['insider', 'Form 4']
  return ['SEC filing']
}

const CORPORATE_SUFFIX =
  /\b(inc|incorporated|corp|corporation|co|com|pbc|llc|ltd|plc|holdings|platforms)\b\.?/gi

/** "AMAZON COM INC" -> "AMAZON", "Anthropic, PBC  (CIK 0002130357)" -> "Anthropic". */
export function filerName(display: string): string | null {
  const name = display
    .replace(/\(.*?\)/g, ' ')
    .replace(CORPORATE_SUFFIX, ' ')
    .replace(/[,.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return name.length >= 3 ? name : null
}

const VERSION_STOP = /^(preview|latest|exp|experimental|\d{4}|\d{8})$/

/**
 * The family a model slug belongs to, as the press writes it: the words up to
 * and including the first version number, dash-spelt versions dotted.
 * gpt-6.1-sol -> "gpt 6.1", claude-sonnet-5-5 -> "claude sonnet 5.5",
 * gemini-3.5-flash-lite -> "gemini 3.5", grok-4.7 -> "grok 4.7". A slug with
 * no number keeps its words: gemini-nano-banana -> "gemini nano banana".
 */
export function modelFamily(slug: string): string | null {
  const words = slug
    .toLowerCase()
    .replace(/\(.*$/, '')
    .split(/[-_\s]+/)
    .filter(Boolean)
  const merged: string[] = []
  for (const word of words) {
    const last = merged.at(-1)
    // claude-opus-5-5: a one- or two-digit run after a number is its minor version.
    if (last !== undefined && /^\d+$/.test(last) && /^\d{1,2}$/.test(word)) {
      merged[merged.length - 1] = `${last}.${word}`
      continue
    }
    merged.push(word)
  }
  const version = merged.findIndex((w, i) => i > 0 && /^\d/.test(w))
  const family =
    version === -1 ? merged.filter((w) => !VERSION_STOP.test(w)) : merged.slice(0, version + 1)
  const phrase = family.join(' ')
  return phrase.length >= 3 ? phrase : null
}

type Payload = Record<string, unknown>

function payloadOf(change: ChangeRow): Payload {
  const json = change.after_json ?? change.before_json
  if (json === null) return {}
  try {
    const value = JSON.parse(json) as unknown
    return value !== null && typeof value === 'object' ? (value as Payload) : {}
  } catch {
    return {}
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

function filingWho(p: Payload): string[] {
  const cik = str(p.whitelist_cik)
  if (cik && FILER_NAMES[cik]) return [FILER_NAMES[cik]!]
  const names = Array.isArray(p.display_names) ? p.display_names : []
  const display = str(names[0]) ?? str(p.entity_name) ?? str(p.name)
  const name = display ? filerName(display) : null
  return name ? [name] : []
}

const uniq = (values: readonly string[]) => {
  const seen = new Set<string>()
  return values.filter((v) => {
    const k = v.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** Terms for one change row, or null for an entity type with no press shape. */
function termsOf(change: ChangeRow): SearchTerms | null {
  const p = payloadOf(change)
  const lab = [...(LAB_NAMES[change.provider] ?? [])]
  switch (change.entity_type) {
    case 'model':
    case 'recommendation': {
      const family = modelFamily(str(p.model_slug) ?? '')
      return family ? { who: [], what: [family], also: [] } : null
    }
    case 'job': {
      if (!lab.length) return null
      const department = str(p.department)
      return department
        ? { who: lab.slice(0, 1), what: [department], also: HIRING }
        : { who: lab.slice(0, 1), what: HIRING, also: [] }
    }
    case 'incident':
      return lab.length ? { who: lab, what: OUTAGE, also: [] } : null
    case 'disclosure':
    case 'disclosure_timeline':
      return lab.length ? { who: lab.slice(0, 1), what: MISALIGNMENT, also: [] } : null
    case 'filing': {
      const who = filingWho(p)
      const form = str(p.form)
      return who.length && form ? { who, what: formTerms(form), also: [] } : null
    }
    case 'filer':
    case 'document':
    case 'offering':
    case 'statement':
    case 'commitment':
    case 'concentration':
    case 'shares':
    case 'revenue':
    case 'risk_factors': {
      // A fact read from a 10-Q is earnings news; one from an S-1 is IPO news.
      const form = str(p.form)
      const what = form ? formTerms(form.replace(/\s*\(.*$/, '')) : IPO
      const who = filingWho(p)
      if (who.length) return { who, what, also: [] }
      return lab.length ? { who: lab.slice(0, 1), what, also: [] } : null
    }
    default:
      return null
  }
}

/** Most phrases one query may OR together; GDELT rejects very long queries. */
export const MAX_PHRASES = 4

/**
 * The terms for an alert: every cited row's terms, merged. Job rows add their
 * departments to one group; model rows their families. Null when no cited
 * row has a press shape (a ranking, say), and the alert is then not searched.
 */
export function alertTerms(changes: readonly ChangeRow[]): SearchTerms | null {
  const parts = changes.map(termsOf).filter((t): t is SearchTerms => t !== null)
  if (parts.length === 0) return null
  return {
    who: uniq(parts.flatMap((t) => t.who)).slice(0, MAX_PHRASES),
    what: uniq(parts.flatMap((t) => t.what)).slice(0, MAX_PHRASES),
    also: uniq(parts.flatMap((t) => t.also)).slice(0, MAX_PHRASES + 1),
  }
}

const quote = (phrase: string) => (/\s|-/.test(phrase) ? `"${phrase}"` : phrase)
const group = (phrases: readonly string[]) =>
  phrases.length === 1 ? quote(phrases[0]!) : `(${phrases.map(quote).join(' OR ')})`

/**
 * The GDELT DOC 2.0 query: `who` AND `what`, English sources only. GDELT
 * rejects parentheses around a single term, so a group of one is bare.
 */
export function gdeltQuery(terms: SearchTerms): string {
  const parts = [terms.who, terms.what, terms.also].filter((g) => g.length > 0).map(group)
  return [...parts, 'sourcelang:english'].join(' ')
}

/** Lowercase words and dotted numbers, so "GPT‑6.1 Sol." and "gpt-6.1-sol" read alike. */
export function normalizeText(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/\.(?!\d)|(?<!\d)\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `
}

/** A newsroom post matches when its title or summary carries any `what` phrase as whole words. */
export function matchesWhat(text: string, terms: SearchTerms): boolean {
  const haystack = normalizeText(text)
  return terms.what.some((phrase) => {
    const needle = normalizeText(phrase)
    return needle.trim().length > 0 && haystack.includes(needle)
  })
}
