// The posted-pay rule: when a lab's posted-pay median for a cell (all roles, research, software
// engineering) has lasted a move of PAY_PCT or more, one alert cites both weeks. No model in the
// loop.
//
// A cell's median is read off a board of tens of roles and flips by a few percent when one role
// opens or closes, so a move counts only when it is sustained: the median of the last 7 days
// against the 7 before, with every day of one window above (or below) every day of the other.
// The recipe stores a row only on a day its cells change, so a day with none carries the last one
// forward. A cell needs MIN_ROLES bands behind it and 14 days of history. A move already alerted
// in the same direction in the last 14 days is not alerted again, so one lasting move is one alert.

import { inArray } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type { PipelineDb } from '#layers/core/server/utils/pipeline-store'
import { companyName } from '#layers/core/shared/utils/companies'
import { compactUsd } from '#layers/core/shared/utils/terminal-format'
import {
  saidSince,
  writeFindings,
  type Finding,
} from '#layers/core/server/pipeline/observation-alerts'
import type { Provider } from '#layers/core/server/utils/contracts'
import { PAY_RECIPES } from '../recipes/pay-bands'

export const PAY_RULE = 'pay-floor' as const

export const PAY_PCT = 5
export const WINDOW_DAYS = 7
const MIN_ROLES = 30
const DAY_MS = 86_400_000

type Row = typeof tables.recipeObservations.$inferSelect

const LABELS: Readonly<Record<string, string>> = {
  all: 'all roles',
  research: 'research roles',
  swe: 'software engineering roles',
}

const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

export interface PayMove {
  before: number
  after: number
  pct: number
  roles: number
  /** The last day of each window. */
  through: { before: string; after: string }
}

const dayStr = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/**
 * Pure: one cell's daily medians (any gaps carried forward) against the rule. `today` is the UTC
 * date being judged; the last day with data may be earlier, and is carried to it.
 */
export function payMove(
  days: readonly { date: string; value: number; roles: number }[],
  today: string,
): PayMove | null {
  const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : 1))
  const first = sorted[0]
  if (!first) return null
  const end = Date.parse(`${today}T00:00:00Z`)
  if (end - Date.parse(`${first.date}T00:00:00Z`) < (2 * WINDOW_DAYS - 1) * DAY_MS) return null
  const daily = (from: number) =>
    Array.from({ length: WINDOW_DAYS }, (_, i) => {
      const date = dayStr(from + i * DAY_MS)
      const last = sorted.filter((d) => d.date <= date).at(-1)
      return last ?? null
    })
  const after = daily(end - (WINDOW_DAYS - 1) * DAY_MS)
  const before = daily(end - (2 * WINDOW_DAYS - 1) * DAY_MS)
  if (after.includes(null) || before.includes(null)) return null
  const a = after.map((d) => d!.value)
  const b = before.map((d) => d!.value)
  const sustained = Math.min(...a) > Math.max(...b) || Math.max(...a) < Math.min(...b)
  const roles = after.at(-1)!.roles
  const pct = ((median(a) - median(b)) / median(b)) * 100
  if (!sustained || Math.abs(pct) < PAY_PCT || roles < MIN_ROLES) return null
  return {
    before: median(b),
    after: median(a),
    pct,
    roles,
    through: { before: dayStr(end - WINDOW_DAYS * DAY_MS), after: today },
  }
}

export function payFinding(
  recipe: { id: string; company: string },
  key: string,
  move: PayMove,
  newest: Row,
): Finding {
  const lab = companyName(recipe.company)
  const cell = LABELS[key] ?? key
  const verb = move.pct > 0 ? 'rises' : 'falls'
  const size = Math.round(Math.abs(move.pct) * 10) / 10
  const pct = Math.round(move.pct * 100) / 100
  return {
    rule: PAY_RULE,
    entity_type: 'pay_band',
    entity_key: `pay_band:${recipe.id}:${key}`,
    provider: recipe.company as Provider,
    period: move.through.after,
    change_type: 'modified',
    before: {
      cell: key,
      summary: `${lab} posted pay, ${cell} · median ${compactUsd(move.before)} · ${move.through.before}`,
      as_of: move.through.before,
      median_usd: move.before,
    },
    after: {
      cell: key,
      summary: `${lab} posted pay, ${cell} · median ${compactUsd(move.after)} · ${move.through.after}`,
      as_of: move.through.after,
      median_usd: move.after,
      roles: move.roles,
      pct_change: pct,
    },
    headline: `${lab}’s posted pay for ${cell} ${verb} ${size}% in a week, to a ${compactUsd(move.after)} median from ${compactUsd(move.before)}`,
    explanation: [
      `The median midpoint of the salary bands ${lab} posts for ${cell} was ${compactUsd(move.before)} over the 7 days to ${move.through.before} and ${compactUsd(move.after)} over the 7 days to ${move.through.after} (${size}%), across ${move.roles} posted bands.`,
      'Bands are posted ranges, not offers, and leave out equity. A median moves when the mix of open roles changes, so read it with the roles on the board.',
      `Rule-based: a 7-day median ${PAY_PCT}% or more from the 7 days before, every day of one window beyond every day of the other, on at least ${MIN_ROLES} bands. No model in the loop.`,
    ].join(' '),
    source_url: newest.source_url,
    fetched_at: newest.fetched_at,
  }
}

interface PayAlertReport {
  written: number
  findings: number
}

export async function writePayAlerts(db: PipelineDb, now = new Date()): Promise<PayAlertReport> {
  const rows = await db
    .select()
    .from(tables.recipeObservations)
    .where(
      inArray(
        tables.recipeObservations.recipe_id,
        PAY_RECIPES.map((r) => r.id),
      ),
    )
  const today = now.toISOString().slice(0, 10)
  const since = new Date(now.getTime() - 2 * WINDOW_DAYS * DAY_MS).toISOString()
  const findings: Finding[] = []
  for (const recipe of PAY_RECIPES) {
    const mine = rows.filter((r) => r.recipe_id === recipe.id && r.value !== null)
    for (const key of new Set(mine.map((r) => r.key))) {
      const cell = mine.filter((r) => r.key === key)
      const move = payMove(
        cell.map((r) => ({
          date: r.date,
          value: r.value!,
          roles: (JSON.parse(r.payload) as { n?: number }).n ?? 0,
        })),
        today,
      )
      if (!move) continue
      const entity = `pay_band:${recipe.id}:${key}`
      if (await saidSince(db, entity, since, move.pct, 'pct_change')) continue
      findings.push(payFinding(recipe, key, move, cell.reduce((a, b) => (b.fetched_at > a.fetched_at ? b : a))))
    }
  }
  return { written: await writeFindings(db, findings, now), findings: findings.length }
}
