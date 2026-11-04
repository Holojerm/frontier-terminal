// The Ramp AI Index: the share of US businesses on Ramp paying for AI each
// month, overall and by vendor, from card and bill-pay spend. It is the one
// enterprise demand series beside OpenRouter's developer traffic. No file or
// API carries it: the numbers are the props object the page streams to its
// charts (Next.js `self.__next_f.push` chunks), read here without a browser.
//
// Ramp restates past months between releases (October 2025's Anthropic rate
// went from 14.3% as published to 16.65%), so each release is stored twice:
// the current series under the vendor's key, and the whole release under
// `<key>@<date first seen>`, which no later release overwrites. The page
// states no license, so only these monthly rates are kept, never the
// industry, size or state tables (docs/source-audit.md, 2026-11-04).

import type { Observation, Recipe } from './contract'

interface MonthRow {
  date_month: string
  adoption_rate_pct: number
  mom_change_pp: number | null
}
interface VendorRow extends MonthRow {
  vendor: string
}
interface IndexProps {
  adoptionOverall: MonthRow[]
  adoptionVendor: VendorRow[]
  dataVersion: string
}

const PUSH = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g
const MONTH = /^\d{4}-\d{2}-01$/

/** The JSON object that starts at `start`, by brace depth outside strings. */
function objectAt(text: string, start: number): string {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  throw new Error('unterminated props object')
}

function isMonthRow(r: unknown): r is MonthRow {
  const row = r as MonthRow
  return MONTH.test(String(row?.date_month)) && typeof row.adoption_rate_pct === 'number'
}

export function readIndexProps(html: string): IndexProps {
  const text = [...html.matchAll(PUSH)].map((m) => JSON.parse(m[1]!) as string).join('')
  const start = text.indexOf('{"adoptionOverall"')
  if (start === -1) throw new Error('no adoptionOverall props in the page')
  const props = JSON.parse(objectAt(text, start)) as Partial<IndexProps>
  const { adoptionOverall, adoptionVendor, dataVersion } = props
  if (
    !Array.isArray(adoptionOverall) ||
    !Array.isArray(adoptionVendor) ||
    typeof dataVersion !== 'string' ||
    !adoptionOverall.every(isMonthRow) ||
    !adoptionVendor.every((r) => isMonthRow(r) && typeof r.vendor === 'string')
  ) {
    throw new Error('adoption series not in the expected shape')
  }
  if (adoptionOverall.length === 0 || adoptionVendor.length === 0) {
    throw new Error('adoption series empty')
  }
  return { adoptionOverall, adoptionVendor, dataVersion }
}

/** "Mistral AI" → "mistral-ai": a vendor Ramp adds later gets a key without a code change. */
export const vendorKey = (vendor: string) =>
  vendor
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

export function extractAiIndex(html: string, ctx: { date: string }): Observation[] {
  const props = readIndexProps(html)
  const rows = [
    ...props.adoptionOverall.map((r) => ({ key: 'overall', vendor: null, ...r })),
    ...props.adoptionVendor.map((r) => ({ ...r, key: vendorKey(r.vendor) })),
  ]
  return rows.flatMap((r) => {
    const payload = {
      vendor: r.vendor,
      mom_change_pp: r.mom_change_pp,
      data_version: props.dataVersion,
    }
    const value = r.adoption_rate_pct
    return [
      { key: r.key, date: r.date_month, value, payload },
      { key: `${r.key}@${ctx.date}`, date: r.date_month, value, payload },
    ]
  })
}

export const RAMP_AI_INDEX: Recipe = {
  id: 'ramp-ai-index',
  company: 'frontier-labs',
  description:
    'Ramp AI Index: monthly share of US businesses on Ramp paying for AI, overall and by vendor',
  url: () => 'https://ramp.com/data/ai-index',
  ext: 'html',
  extract: extractAiIndex,
  // The page carries a per-request trace id, so its bytes differ on every
  // fetch; a release is new only when the series or its version is.
  fingerprint: (html) => JSON.stringify(readIndexProps(html)),
}
