// Published API rate limits, per lab, model, tier and metric, from the labs'
// own Markdown docs. Limits are tier design and abuse control as much as
// capacity, and they move in announced steps (OpenAI cut five tiers to three
// on 2026-10-06; Anthropic raised limits on 2026-06-26), so each change is
// stored as a dated snapshot of the whole table: one row per limit, dated the
// run that first saw it. Google and Mistral publish no per-model limits (cut
// in sources.yaml). Audited in docs/source-audit.md, 2026-11-04.

import type { CompanyId } from '../../../shared/utils/companies'
import type { Observation, Recipe } from './contract'

export interface MdTable {
  /** The nearest `##` heading above the table. */
  section: string
  /** The nearest `###` heading below that section, or ''. */
  subsection: string
  /** The enclosing `<Tab title="…">`, or ''. */
  tab: string
  header: string[]
  rows: string[][]
}

/** Strip the inline markup a docs cell carries: footnote sups, links, code ticks, bold. */
export const cellText = (cell: string) =>
  cell
    .replace(/<sup>.*?<\/sup>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
    .trim()

const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map(cellText)

/** Every pipe table in a Markdown page, with the headings and tab it sits under. */
export function mdTables(md: string): MdTable[] {
  const tables: MdTable[] = []
  let section = ''
  let subsection = ''
  let tab = ''
  const lines = md.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    const h = /^(#{2,3})\s+(.*)$/.exec(line)
    if (h) {
      if (h[1] === '##') {
        section = h[2]!.trim()
        subsection = ''
      } else subsection = h[2]!.trim()
      continue
    }
    const t = /^<Tab title="([^"]*)">/.exec(line)
    if (t) tab = t[1]!
    if (line.startsWith('</Tab>')) tab = ''
    if (!line.startsWith('|') || !lines[i + 1]?.trim().match(/^\|[\s:|-]+\|$/)) continue
    const header = splitRow(line)
    const rows: string[][] = []
    i += 2
    while (i < lines.length && lines[i]!.trim().startsWith('|')) rows.push(splitRow(lines[i++]!))
    i--
    tables.push({ section, subsection, tab, header, rows })
  }
  return tables
}

const SUFFIX: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9 }

/** "4,000" → 4000, "2.5M" → 2.5e6; a dash, "None" or blank is no limit published (null). */
export function limitValue(cell: string): number | null {
  const s = cell.replace(/,/g, '').replace(/^\$/, '').trim()
  if (s === '' || s === '—' || s === '-' || /^none$/i.test(s)) return null
  const m = /^(\d+(?:\.\d+)?)\s*([KMB])?$/i.exec(s)
  if (!m) throw new Error(`not a limit: ${cell}`)
  return Number(m[1]) * (m[2] ? SUFFIX[m[2].toUpperCase()]! : 1)
}

/** "Maximum requests per minute (RPM)" → "RPM"; a plain header stays as written. */
const metricName = (header: string) => /\(([A-Z]+)\)\s*$/.exec(header)?.[1] ?? header

function limit(
  model: string,
  tier: string,
  metric: string,
  value: number | null,
  date: string,
  extra: Record<string, unknown> = {},
): Observation {
  return {
    key: `${model}|${tier}|${metric}`,
    date,
    value,
    payload: { model, tier, metric, ...extra },
  }
}

function nonEmpty(obs: Observation[], what: string): Observation[] {
  if (obs.length === 0) throw new Error(`no ${what} found`)
  return obs
}

/** OpenAI's per-model page: `## Rate limits`, a Tier | RPM | TPM | Batch queue limit table. */
export function extractOpenAiLimits(md: string, slug: string, date: string): Observation[] {
  const obs: Observation[] = []
  for (const t of mdTables(md).filter((t) => t.section === 'Rate limits')) {
    if (t.header[0] !== 'Tier') throw new Error(`unexpected rate-limit header: ${t.header[0]}`)
    for (const row of t.rows) {
      t.header.slice(1).forEach((h, j) => {
        obs.push(
          limit(slug, row[0]!, h, limitValue(row[j + 1] ?? ''), date, { variant: t.subsection }),
        )
      })
    }
  }
  return nonEmpty(obs, 'OpenAI rate-limit table')
}

/** Anthropic: one Messages table per tier tab, batch tables per tier, and the spend cap per tier. */
export function extractAnthropicLimits(md: string, date: string): Observation[] {
  const obs: Observation[] = []
  for (const t of mdTables(md)) {
    const tier = t.tab.replace(/ tier$/, '')
    if (t.section === 'Spend limits' && t.header[0] === 'Usage tier') {
      for (const row of t.rows)
        obs.push(
          limit(
            'spend cap',
            row[0]!,
            'USD per month',
            limitValue(row[1]!.replace(/ USD$/, '')),
            date,
          ),
        )
    } else if (t.section === 'Rate limits' && t.header[0] === 'Model' && tier) {
      for (const row of t.rows) {
        t.header.slice(1).forEach((h, j) => {
          obs.push(limit(row[0]!, tier, metricName(h), limitValue(row[j + 1] ?? ''), date))
        })
      }
    } else if (t.subsection === 'Message Batches API' && tier) {
      for (const row of t.rows) {
        t.header.forEach((h, j) =>
          obs.push(
            limit('Message Batches API', tier, metricName(h), limitValue(row[j] ?? ''), date),
          ),
        )
      }
    }
  }
  return nonEmpty(obs, 'Anthropic rate-limit tables')
}

/** xAI packs every tier into one cell: "T0: 150, T1: 172, …". The spend threshold table names the tiers. */
export function extractXaiLimits(md: string, date: string): Observation[] {
  const obs: Observation[] = []
  for (const t of mdTables(md)) {
    if (t.header[0] === 'Tier' && t.header[1] === 'Spend threshold') {
      for (const row of t.rows) {
        const usd = /^\$([\d,]+)/.exec(row[1]!)
        obs.push(
          limit('spend threshold', row[0]!, 'USD', usd ? limitValue(usd[1]!) : null, date, {
            text: row[1],
          }),
        )
      }
    } else if (t.header[0] === 'Model') {
      for (const row of t.rows) {
        t.header.slice(1).forEach((h, j) => {
          const cell = row[j + 1] ?? ''
          if (/^(—|-|)$/.test(cell.trim())) return
          for (const part of cell.split(',')) {
            const m = /^\s*(T\d):\s*(.+?)\s*$/.exec(part)
            if (!m) throw new Error(`xAI cell not in tier form: ${cell}`)
            obs.push(limit(row[0]!, m[1]!, h, limitValue(m[2]!), date))
          }
        })
      }
    }
  }
  return nonEmpty(obs, 'xAI rate-limit tables')
}

/** Meta: one Model | RPM | TPM | Other limits table, no tiers; "Other limits" is kept as text. */
export function extractMetaLimits(md: string, date: string): Observation[] {
  const obs: Observation[] = []
  for (const t of mdTables(md).filter(
    (t) => t.section === 'Rate limits' && t.header[0] === 'Model',
  )) {
    for (const row of t.rows) {
      t.header.slice(1).forEach((h, j) => {
        const cell = row[j + 1] ?? ''
        if (/^Other limits$/i.test(h)) {
          if (cell) obs.push(limit(row[0]!, 'all', 'other', null, date, { text: cell }))
        } else obs.push(limit(row[0]!, 'all', metricName(h), limitValue(cell), date))
      })
    }
  }
  return nonEmpty(obs, 'Meta rate-limit table')
}

function limitsRecipe(
  id: string,
  company: CompanyId,
  what: string,
  url: string,
  read: (md: string, date: string) => Observation[],
): Recipe {
  return {
    id,
    company,
    description: `Published API rate limits: ${what}`,
    url: () => url,
    ext: 'md',
    extract: (md, ctx) => read(md, ctx.date),
    // A docs edit elsewhere on the page is not a limit change.
    fingerprint: (md) => JSON.stringify(read(md, '').map((o) => [o.key, o.value, o.payload])),
  }
}

/** OpenAI's flagship, balanced and economy models (terminal-classes.ts at 2026-11-04). */
const OPENAI_LIMIT_MODELS = ['gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.6-luna'] as const

export const RATE_LIMIT_RECIPES: readonly Recipe[] = [
  ...OPENAI_LIMIT_MODELS.map((slug) =>
    limitsRecipe(
      `limits-openai-${slug.replace(/\./g, '-')}`,
      'openai',
      `OpenAI ${slug}, per usage tier`,
      `https://developers.openai.com/api/docs/models/${slug}.md`,
      (md, date) => extractOpenAiLimits(md, slug, date),
    ),
  ),
  limitsRecipe(
    'limits-anthropic',
    'anthropic',
    'Anthropic, per model and usage tier, with batch limits and spend caps',
    'https://platform.claude.com/docs/en/api/rate-limits.md',
    extractAnthropicLimits,
  ),
  limitsRecipe(
    'limits-xai',
    'xai',
    'xAI, per model and tier (T0–T4), with spend thresholds',
    'https://docs.x.ai/developers/rate-limits.md',
    extractXaiLimits,
  ),
  limitsRecipe(
    'limits-meta',
    'meta',
    'Meta, per model (no tiers)',
    'https://dev.meta.ai/docs/pricing-rate-limits.md',
    extractMetaLimits,
  ),
]
