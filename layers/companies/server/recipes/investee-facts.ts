// What a public parent tags about a private lab in its own XBRL: every fact whose
// context names the lab's member (msft:OpenAIGlobalLlcMember, amzn:AnthropicMember),
// read from the newest 10-Q/10-K instance since company facts drop dimensions.
// These are the parent's numbers, never the lab's: Microsoft accounts at
// hypothetical liquidation value with dilution gains in the same line, and
// Amazon's marks follow observable prices (docs/source-audit.md).

import type { Observation, Recipe } from '#layers/core/server/recipes/contract'

interface Context {
  dims: [string, string][]
  start: string | null
  end: string
}

const DAY_MS = 86_400_000

function contexts(xml: string): Map<string, Context> {
  const out = new Map<string, Context>()
  for (const m of xml.matchAll(
    /<(?:xbrli:)?context id="([^"]+)">([\s\S]*?)<\/(?:xbrli:)?context>/g,
  )) {
    const body = m[2]!
    const dims = [
      ...body.matchAll(/<xbrldi:explicitMember dimension="([^"]+)">\s*([^<\s]+)\s*</g),
    ].map((d) => [d[1]!, d[2]!] as [string, string])
    const instant = /<(?:xbrli:)?instant>([^<]+)</.exec(body)?.[1]
    const start = /<(?:xbrli:)?startDate>([^<]+)</.exec(body)?.[1]
    const end = /<(?:xbrli:)?endDate>([^<]+)</.exec(body)?.[1]
    if (instant) out.set(m[1]!, { dims, start: null, end: instant.trim() })
    else if (start && end) out.set(m[1]!, { dims, start: start.trim(), end: end.trim() })
  }
  return out
}

/** "3m" for a quarter, "9m" year to date, "instant" for a balance. */
function span(c: Context): string {
  if (!c.start) return 'instant'
  const days = (Date.parse(c.end) - Date.parse(c.start)) / DAY_MS + 1
  return `${Math.round(days / 30.44)}m`
}

const local = (qname: string) => qname.slice(qname.indexOf(':') + 1)

export function extractInvesteeFacts(xml: string, member: string): Observation[] {
  if (!/<(?:xbrli:)?xbrl\b/.test(xml)) throw new Error('not an XBRL instance')
  const ctx = new Map([...contexts(xml)].filter(([, c]) => c.dims.some(([, m]) => m === member)))
  const obs: Observation[] = []
  for (const m of xml.matchAll(/<([\w-]+:\w+)\b([^>]*?)\bcontextRef="([^"]+)"([^>]*)>([^<]*)</g)) {
    const c = ctx.get(m[3]!)
    if (!c) continue
    const attrs = m[2]! + m[4]!
    const raw = m[5]!.trim()
    const numeric = /\bunitRef="/.test(attrs)
    const others = c.dims
      .filter(([, mem]) => mem !== member)
      .map(([dim, mem]) => `${local(dim)}=${local(mem)}`)
      .join(',')
    obs.push({
      key: [local(m[1]!), others, span(c)].filter(Boolean).join('|'),
      date: c.end,
      value: numeric ? Number(raw) : null,
      payload: {
        concept: m[1],
        dimensions: c.dims,
        start: c.start,
        end: c.end,
        decimals: /\bdecimals="([^"]+)"/.exec(attrs)?.[1] ?? null,
        unit: /\bunitRef="([^"]+)"/.exec(attrs)?.[1] ?? null,
        ...(numeric ? {} : { text: raw }),
      },
    })
  }
  if (obs.length === 0) throw new Error(`no facts tagged ${member}`)
  return obs
}

/** The newest 10-Q or 10-K's instance file, named after its primary document. */
export function newestInstanceUrl(submissions: string, cik: number): string {
  const doc = JSON.parse(submissions) as {
    filings?: { recent?: { form: string[]; accessionNumber: string[]; primaryDocument: string[] } }
  }
  const r = doc.filings?.recent
  if (!r) throw new Error('not an EDGAR submissions feed')
  const i = r.form.findIndex((f) => f === '10-Q' || f === '10-K')
  if (i === -1) throw new Error('no 10-Q or 10-K in the feed')
  const primary = r.primaryDocument[i]!
  if (!/\.htm$/.test(primary)) throw new Error(`primary document is not inline XBRL: ${primary}`)
  const accession = r.accessionNumber[i]!.replace(/-/g, '')
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${accession}/${primary.replace(/\.htm$/, '_htm.xml')}`
}

function investeeRecipe(
  id: string,
  company: 'openai' | 'anthropic',
  parent: string,
  cik: number,
  member: string,
): Recipe {
  return {
    id,
    company,
    description: `${parent}'s XBRL facts on ${member}, from its newest 10-Q or 10-K`,
    url: () => `https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`,
    follow: (body) => newestInstanceUrl(body, cik),
    ext: 'xml',
    extract: (xml) => extractInvesteeFacts(xml, member),
  }
}

export const INVESTEE_RECIPES: readonly Recipe[] = [
  investeeRecipe('sec-msft-openai', 'openai', 'Microsoft', 789019, 'msft:OpenAIGlobalLlcMember'),
  investeeRecipe('sec-amzn-anthropic', 'anthropic', 'Amazon', 1018724, 'amzn:AnthropicMember'),
]
