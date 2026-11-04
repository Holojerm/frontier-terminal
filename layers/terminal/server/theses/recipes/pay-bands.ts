// Posted salary bands on the labs' own job boards, which US pay-transparency
// laws require. Each run reduces a board to a few cells: the median midpoint
// of every USD annual band, overall and for research and software
// engineering, with its quartiles and counts. One row per cell, dated the
// run that saw it change; the board's bytes are kept in R2 for the roles
// behind each number.
//
// Bands are posted ranges, not offers; they cover US postings only and
// exclude equity, the larger part of pay at these labs. The signal is a
// cell's change over time, not the gap between labs: the department mapping
// below is kept by hand ("Applied AI" is product engineering at OpenAI and
// solutions architects at Anthropic), and sales is left out because Anthropic
// posts on-target earnings and OpenAI base pay. xAI's structured pay field is
// empty and Mistral posts none (cut in sources.yaml; docs/source-audit.md,
// 2026-11-04).

import type { Observation, Recipe } from './contract'

export interface Band {
  title: string
  department: string
  min: number
  max: number
}

/** Role families by each board's own department labels. */
export const FAMILIES: Record<'openai' | 'anthropic', Record<string, readonly string[]>> = {
  openai: { research: ['Research'], swe: ['Applied AI'] },
  anthropic: {
    research: ['AI Research & Engineering'],
    swe: ['Engineering & Design - Product', 'Software Engineering - Infrastructure'],
  },
}

/** A band whose top is under this is a placeholder ($1–$2), not a salary. */
const PLACEHOLDER_MAX_USD = 1_000

const quantile = (sorted: readonly number[], q: number) => {
  const at = (sorted.length - 1) * q
  const lo = Math.floor(at)
  return sorted[lo]! + (sorted[Math.ceil(at)]! - sorted[lo]!) * (at - lo)
}

/** One observation per cell: the median band midpoint, with its spread and the count behind it. */
export function bandCells(
  bands: readonly Band[],
  roles: number,
  families: Record<string, readonly string[]>,
  date: string,
): Observation[] {
  const cells: [string, readonly Band[], readonly string[] | null][] = [
    ['all', bands, null],
    ...Object.entries(families).map(
      ([family, depts]) =>
        [family, bands.filter((b) => depts.includes(b.department)), depts] as [
          string,
          Band[],
          readonly string[],
        ],
    ),
  ]
  return cells.map(([key, cell, departments]) => {
    const mids = cell.map((b) => (b.min + b.max) / 2).sort((a, b) => a - b)
    if (mids.length === 0) throw new Error(`no bands in cell ${key}`)
    return {
      key,
      date,
      value: quantile(mids, 0.5),
      payload: {
        n: mids.length,
        p25: quantile(mids, 0.25),
        p75: quantile(mids, 0.75),
        roles_on_board: roles,
        departments,
      },
    }
  })
}

export function openaiBands(body: string): { bands: Band[]; roles: number } {
  const doc = JSON.parse(body) as {
    jobs?: {
      title: string
      department?: string
      compensation?: {
        summaryComponents?: {
          compensationType: string
          interval: string
          currencyCode: string
          minValue: number | null
          maxValue: number | null
        }[]
      }
    }[]
  }
  if (!Array.isArray(doc.jobs)) throw new Error('not an Ashby job board')
  // Without includeCompensation the key is absent on every job: refuse rather than read zero bands.
  if (!doc.jobs.some((j) => j.compensation)) throw new Error('no compensation on the board')
  const bands: Band[] = []
  for (const j of doc.jobs) {
    const s = j.compensation?.summaryComponents?.find(
      (c) =>
        c.compensationType === 'Salary' &&
        c.currencyCode === 'USD' &&
        c.interval === '1 YEAR' &&
        c.minValue !== null &&
        c.maxValue !== null,
    )
    if (s && s.maxValue! >= PLACEHOLDER_MAX_USD) {
      bands.push({
        title: j.title,
        department: j.department ?? '',
        min: s.minValue!,
        max: s.maxValue!,
      })
    }
  }
  return { bands, roles: doc.jobs.length }
}

export function anthropicBands(body: string): { bands: Band[]; roles: number } {
  const doc = JSON.parse(body) as {
    jobs?: {
      title: string
      departments?: { name: string }[]
      pay_input_ranges?: { min_cents: number; max_cents: number; currency_type: string }[]
    }[]
  }
  if (!Array.isArray(doc.jobs)) throw new Error('not a Greenhouse job board')
  if (!doc.jobs.some((j) => Array.isArray(j.pay_input_ranges))) {
    throw new Error('no pay_input_ranges on the board')
  }
  const bands: Band[] = []
  for (const j of doc.jobs) {
    const r = j.pay_input_ranges?.find((p) => p.currency_type === 'USD')
    if (r && r.max_cents / 100 >= PLACEHOLDER_MAX_USD) {
      bands.push({
        title: j.title,
        department: j.departments?.[0]?.name ?? '',
        min: r.min_cents / 100,
        max: r.max_cents / 100,
      })
    }
  }
  return { bands, roles: doc.jobs.length }
}

function payRecipe(
  id: string,
  company: 'openai' | 'anthropic',
  board: string,
  url: string,
  read: (body: string) => { bands: Band[]; roles: number },
): Recipe {
  const cells = (body: string, date: string) => {
    const { bands, roles } = read(body)
    return bandCells(bands, roles, FAMILIES[company], date)
  }
  return {
    id,
    company,
    description: `Posted US salary bands on ${board}: median midpoint overall, research and software engineering`,
    url: () => url,
    ext: 'json',
    extract: (body, ctx) => cells(body, ctx.date),
    // The board changes every tick as roles open and close; a new row is
    // worth storing only when a cell moves.
    fingerprint: (body) => JSON.stringify(cells(body, '').map((o) => [o.key, o.value, o.payload])),
  }
}

export const PAY_RECIPES: readonly Recipe[] = [
  payRecipe(
    'pay-openai',
    'openai',
    "OpenAI's Ashby board",
    'https://api.ashbyhq.com/posting-api/job-board/openai?includeCompensation=true',
    openaiBands,
  ),
  payRecipe(
    'pay-anthropic',
    'anthropic',
    "Anthropic's Greenhouse board",
    'https://boards-api.greenhouse.io/v1/boards/anthropic/jobs?content=true&pay_transparency=true',
    anthropicBands,
  ),
]
