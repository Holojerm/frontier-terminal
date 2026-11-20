// What the judge is shown of a filing that names a lab site, and the checks a
// tie it sends back must pass. Pure, so layers/terminal/test/power-sites-ingest.test.ts
// runs them without a database.

import type { PowerRole } from '../../shared/utils/power-sites'
import { contains } from '../suppliers/excerpts'

export { contains, documentText } from '../suppliers/excerpts'

/** Characters of excerpts offered per document, and the run around each hit. */
export const EXCERPT_CHARS = 16_000
const WINDOW = 900

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Words that say a run is about power at all. */
const POWER =
  /\b(?:MW|GW|megawatts?|gigawatts?|power|electric\w*|energy|utilit(?:y|ies)|grid|substation|interconnect\w*|transmission|generat\w+|turbines?|fuel cells?)\b/i

/**
 * Runs of the text around each name of the site, merged where they overlap,
 * kept only when they speak of power, those with a megawatt figure first, up
 * to EXCERPT_CHARS. Each run is a verbatim slice of `text`.
 */
export function powerExcerpts(text: string, terms: readonly string[]): string[] {
  if (terms.length === 0) return []
  const pattern = new RegExp(`\\b(?:${terms.map(escape).join('|')})\\b`, 'gi')
  const runs: [number, number][] = []
  for (const m of text.matchAll(pattern)) {
    const start = Math.max(0, m.index - WINDOW / 2)
    const end = Math.min(text.length, m.index + WINDOW / 2)
    const last = runs.at(-1)
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else runs.push([start, end])
  }
  const slices = runs.map(([s, e]) => text.slice(s, e)).filter((s) => POWER.test(s))
  const figure = (s: string) => /\d\s?(?:MW|GW|megawatts?|gigawatts?)\b/i.test(s)
  const ranked = [...slices.filter(figure), ...slices.filter((s) => !figure(s))]
  const out: string[] = []
  let used = 0
  for (const s of ranked) {
    if (used + s.length > EXCERPT_CHARS) continue
    out.push(s)
    used += s.length
  }
  return out
}

/**
 * What a quote must say for each role. A utility serves or connects the site,
 * a generator makes its power, an equipment maker supplies the machines, a
 * host owns, leases or runs the site.
 */
export const ROLE_CUES: Readonly<Record<PowerRole, RegExp>> = {
  utility:
    /\b(?:utilit(?:y|ies)|electric(?:al)? (?:service|company|cooperative)|power authority|interconnect\w*|transmission|substation|serve[sd]?|service agreement|tariff|load)\b/i,
  generation:
    /\b(?:generat\w+|power plants?|power station|turbines?|solar|wind|batter(?:y|ies)|storage|natural gas|nuclear|fuel cells?|behind[- ]the[- ]meter|on-?site power|power purchase)\b/i,
  equipment:
    /\b(?:turbines?|fuel cells?|transformers?|switchgear|generators?|equipment|batter(?:y|ies)|units|order(?:s|ed)?|deliver\w*|suppl\w+)\b/i,
  host: /\b(?:data cent(?:er|re)s?|campus|site|facility|facilities|lease[sd]?|leasing|tenant|host\w*|coloca\w+|critical IT|IT load|develop\w*|own(?:s|ed|er)?|operat\w+)\b/i,
}

/** Whether the quote says something of the kind the role claims. */
export const roleStated = (quote: string, role: PowerRole): boolean => ROLE_CUES[role].test(quote)

/** Whether the quote writes `mw` megawatts: "1,200 MW", "1.2 gigawatts", "500 megawatts". */
export function mwWritten(quote: string, mw: number): boolean {
  for (const m of quote.matchAll(
    /(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?(-?\s?)(MW|megawatts?|GW|gigawatts?)\b/gi,
  )) {
    const n = Number(`${m[1]!.replace(/,/g, '')}${m[2] ?? ''}`)
    const mega = /^m/i.test(m[4]!) ? n : n * 1000
    if (Math.abs(mega - mw) <= Math.abs(mw) * 1e-9) return true
  }
  return false
}

/** Whether the quote names the site by one of the names it was searched for. */
export const siteNamed = (quote: string, terms: readonly string[]): boolean =>
  terms.some((t) => contains(quote, t))
