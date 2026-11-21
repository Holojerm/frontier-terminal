// Anthropic's rate-limit page as the Internet Archive holds it, from March
// 2024: the usage-tier table (what a tier costs to reach and what it may
// spend) and, where the copy says which tier a table is for, the per-model
// limits. The live recipe reads the page's Markdown (limits-anthropic); these
// copies are HTML in four layouts:
//
//   2024-03  docs.anthropic.com/claude/reference/rate-limits: first one rate
//            table with a row per tier for all models, then radio buttons,
//            each tier's table in <div id="tier1"> under a <label> naming it;
//   2024-05  docs.anthropic.com/en/api/rate-limits: a tab list whose first
//            tab's table is the one the copy renders;
//   2025-03  the same URL, every tab's table rendered, plus one more, so no
//            table can be tied to a tier and none is read;
//   2025-11  platform.claude.com: the rate tables render in the browser only.
//
// Columns are read by their header, never their position: the usage-tier
// table's last column was "Max usage per month" (a spend cap) until 2025 and
// "Max credit purchase" (a deposit cap) after. A table this reader can't tie
// to a tier is named in `passed`, never guessed.

import { cellText, limitValue } from '../../../recipes/rate-limits'

export interface ArchivedLimit {
  /** As the live recipe keys it: `<model>|<tier>|<metric>`. */
  key: string
  model: string
  tier: string
  metric: string
  value: number | null
  /** The tier and column as the copy printed them. */
  printed: { tier: string; column: string }
}

export interface ArchivedLimitsRead {
  rows: ArchivedLimit[]
  /** What the copy printed that wasn't read, and why. */
  passed: string[]
}

const clean = (html: string) =>
  cellText(
    html
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#x27;|&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&nbsp;|​/g, ' ')
      .replace(/\s+/g, ' '),
  ).replace(/\*+$/, '')

function tableRows(table: string): string[][] {
  return [...table.matchAll(/<tr\b[\s\S]*?<\/tr>/g)].map((r) =>
    [...r[0].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => clean(c[1]!)),
  )
}

/** "Build Tier 1" and "Tier 1" are the same tier, renamed in 2024. */
export const tierName = (printed: string) => printed.replace(/^Build\s+/i, '').trim()

/** "Requests per minute (RPM)" → RPM; a header without one stays as written. */
const metricOf = (header: string) => /\(([A-Z]+)\)\s*$/.exec(header)?.[1] ?? header

/** The usage-tier columns this reader knows, by header. */
const TIER_COLUMNS: readonly { test: RegExp; model: string; metric: string }[] = [
  {
    test: /^(max usage per month|monthly spend (limit|cap))$/i,
    model: 'spend cap',
    metric: 'USD per month',
  },
  { test: /^max credit purchase$/i, model: 'max credit purchase', metric: 'USD' },
  { test: /^credit purchase$/i, model: 'credit purchase to reach tier', metric: 'USD' },
  { test: /^wait after first purchase$/i, model: 'wait to reach tier', metric: 'days' },
]

/** "N/A", "Custom" (the Scale tier, set by contract) and "No limit" are no figure published. */
const figure = (cell: string) =>
  /^(n\/a|custom|no limit)$/i.test(cell.trim()) ? null : limitValue(cell.replace(/\s*USD$/, ''))

function days(cell: string): number | null {
  if (/^(n\/a|—|-|)$/i.test(cell.trim())) return null
  const m = /^(\d+)\s*days?$/i.exec(cell.trim())
  if (!m) throw new Error(`not a wait: ${cell}`)
  return Number(m[1])
}

function tierTable(rows: string[][]): ArchivedLimit[] {
  // The 2024-03 copy splits its header over two rows: "Requirements to
  // advance to tier" spans credit purchase and wait.
  // Some copies pad a header row with empty cells.
  const unpadded = (r: string[]) => {
    const out = [...r]
    while (out.length && out.at(-1) === '') out.pop()
    return out
  }
  let header = unpadded(rows[0]!)
  let body = rows.slice(1)
  if (
    /requirements/i.test(header.join(' ')) &&
    rows[1] &&
    unpadded(rows[1]).length < header.length + 1
  ) {
    header = [header[0]!, ...unpadded(rows[1]), ...header.slice(2)]
    body = rows.slice(2)
  }
  const out: ArchivedLimit[] = []
  header.slice(1).forEach((column, j) => {
    const col = TIER_COLUMNS.find((c) => c.test.test(column))
    if (!col) throw new Error(`unknown usage-tier column: ${column}`)
    for (const row of body) {
      const printed = row[0]!
      const cell = row[j + 1] ?? ''
      const value = col.metric === 'days' ? days(cell) : figure(cell)
      const tier = tierName(printed)
      out.push({
        key: `${col.model}|${tier}|${col.metric}`,
        model: col.model,
        tier,
        metric: col.metric,
        value,
        printed: { tier: printed, column },
      })
    }
  })
  return out
}

function rateTable(rows: string[][], tier: string): ArchivedLimit[] {
  const [header, ...body] = rows
  if (!header || !/^model/i.test(header[0]!)) throw new Error(`not a rate table: ${header?.[0]}`)
  const out: ArchivedLimit[] = []
  for (const row of body) {
    header.slice(1).forEach((column, j) => {
      const metric = metricOf(column)
      out.push({
        key: `${row[0]!}|${tierName(tier)}|${metric}`,
        model: row[0]!,
        tier: tierName(tier),
        metric,
        value: figure(row[j + 1] ?? ''),
        printed: { tier, column },
      })
    })
  }
  return out
}

/**
 * The tier a rate table is for, where the copy says so: the 2024-03 radio
 * layout's <div id="tier1"> and its <label for="ratelimit-tier1">, or a tab
 * list that renders exactly one table, its first tab's.
 */
function tierOfTable(before: string, labels: Map<string, string>): string | null {
  const div = [...before.matchAll(/<div\b[^>]*\bid="(free|tier\d|scale|custom)"/g)].at(-1)
  return div ? (labels.get(div[1]!) ?? null) : null
}

export function parseAnthropicLimitsHtml(html: string): ArchivedLimitsRead {
  if (!/rate limits/i.test(html)) throw new Error('not the rate-limits page')
  const labels = new Map(
    [...html.matchAll(/<label\b[^>]*for="ratelimit-([\w-]+)"[^>]*>([\s\S]*?)<\/label>/g)].map(
      (m) => [m[1]!, clean(m[2]!)] as [string, string],
    ),
  )
  const rows: ArchivedLimit[] = []
  const passed: string[] = []
  let tiers = 0

  // The tab containers of the Mintlify layouts: a tab list, then its panels.
  const tabbed: { from: number; to: number; first: string; tables: number }[] = []
  for (const m of html.matchAll(
    /<ul\b[^>]*>((?:\s*<li\b[^>]*>\s*<button\b[^>]*>[\s\S]*?<\/button>\s*<\/li>)+)\s*<\/ul>/g,
  )) {
    const buttons = [...m[1]!.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((b) =>
      clean(b[1]!),
    )
    if (!buttons.some((b) => /tier/i.test(b))) continue
    const from = m.index! + m[0].length
    const next = html.indexOf('<h2', from)
    tabbed.push({ from, to: next === -1 ? html.length : next, first: buttons[0]!, tables: 0 })
  }
  const tables = [...html.matchAll(/<table\b[\s\S]*?<\/table>/g)]
  for (const t of tables) {
    const tab = tabbed.find((c) => t.index! >= c.from && t.index! < c.to)
    if (tab) tab.tables++
  }

  for (const t of tables) {
    const body = tableRows(t[0])
    if (body.length < 2) continue
    const first = body[0]![0] ?? ''
    if (/^usage tier$/i.test(first)) {
      // Early March 2024: one rate table, a row per tier, for every model alike.
      if (body[0]!.slice(1).every((h) => /\([A-Z]+\)\s*$/.test(h))) {
        for (const row of body.slice(1))
          rows.push(
            ...rateTable(
              [
                ['Model', ...body[0]!.slice(1)],
                ['all models', ...row.slice(1)],
              ],
              row[0]!,
            ),
          )
      } else {
        rows.push(...tierTable(body))
        tiers++
      }
      continue
    }
    if (!/^model/i.test(first)) continue
    const tab = tabbed.find((c) => t.index! >= c.from && t.index! < c.to)
    const tier = tab
      ? tab.tables === 1
        ? tab.first
        : null
      : tierOfTable(html.slice(0, t.index!), labels)
    if (!tier) {
      passed.push(
        tab
          ? `a rate table in tabs that render ${tab.tables} tables for their tiers, none labeled`
          : 'a rate table no tier labels',
      )
      continue
    }
    rows.push(...rateTable(body, tier))
  }
  if (tiers === 0) throw new Error('no usage-tier table')
  return { rows, passed: [...new Set(passed)] }
}
