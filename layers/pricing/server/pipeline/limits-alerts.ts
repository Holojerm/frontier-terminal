// The rate-limit rule: when a lab's newest published limits differ from the snapshot before in a
// limit that existed in both, one alert per model cites the tiers and metrics that moved. No
// model in the loop.
//
// A limit counts as moved when both snapshots print a number and it differs by MOVE_PCT or more,
// or when it goes from a number to none (unlimited, or no longer published for that tier) or back.
// A model or tier present in only one snapshot is not a move: a new model is already a
// `model-floor` alert, and a retired or renamed one ("Claude Fable 5.x" to "Claude Fable 5.2")
// would read as a removal. Only the newest snapshot against the one before is read, and only when
// under FRESH_DAYS old, so a first run over stored history alerts on nothing. Ids hash (lab,
// model, snapshot date), so a re-run writes nothing twice.

import { inArray } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type { PipelineDb } from '#layers/core/server/utils/pipeline-store'
import { companyName } from '#layers/core/shared/utils/companies'
import { writeFindings, type Finding } from '#layers/core/server/pipeline/observation-alerts'
import type { Provider } from '#layers/core/server/utils/contracts'
import { RATE_LIMIT_RECIPES } from '../recipes/rate-limits'

export const LIMITS_RULE = 'limits-floor' as const

export const MOVE_PCT = 10
const FRESH_DAYS = 7
/** Moves listed in the explanation before "and N more". */
const LISTED = 6
const DAY_MS = 86_400_000

type Row = typeof tables.recipeObservations.$inferSelect

export interface LimitMove {
  model: string
  tier: string
  metric: string
  before: number | null
  after: number | null
}

const parts = (r: Row) => {
  const p = JSON.parse(r.payload) as { model?: string; tier?: string; metric?: string }
  const [model, tier, metric] = r.key.split('|')
  return { model: p.model ?? model!, tier: p.tier ?? tier!, metric: p.metric ?? metric! }
}

/** Pure: the limits that moved between two snapshots, grouped by model. */
export function limitMoves(
  earlier: readonly Row[],
  later: readonly Row[],
): Map<string, LimitMove[]> {
  const before = new Map(earlier.map((r) => [r.key, r]))
  const out = new Map<string, LimitMove[]>()
  for (const r of later) {
    const b = before.get(r.key)
    const { model, tier, metric } = parts(r)
    // 'other' rows carry prose in their payload, not a number.
    if (!b || metric === 'other') continue
    const moved =
      b.value === null || r.value === null
        ? b.value !== r.value
        : b.value !== 0 && (Math.abs(r.value - b.value) / b.value) * 100 >= MOVE_PCT
    if (!moved) continue
    out.set(model, [
      ...(out.get(model) ?? []),
      { model, tier, metric, before: b.value, after: r.value },
    ])
  }
  return out
}

const n = (v: number | null) => (v === null ? 'none' : v.toLocaleString('en-US'))

const describe = (m: LimitMove) => `${m.tier} ${m.metric} ${n(m.before)} to ${n(m.after)}`

function finding(
  recipe: { id: string; company: string },
  model: string,
  moves: readonly LimitMove[],
  dates: { earlier: string; later: string },
  newest: Row,
): Finding {
  const lab = companyName(recipe.company)
  const listed = moves.slice(0, LISTED).map(describe).join('; ')
  const more = moves.length > LISTED ? `; and ${moves.length - LISTED} more` : ''
  const up = moves.filter((m) => (m.after ?? Infinity) > (m.before ?? Infinity)).length
  const down = moves.filter((m) => (m.after ?? Infinity) < (m.before ?? Infinity)).length
  const one = moves.length === 1 ? moves[0]! : null
  const headline = one
    ? `${lab} ${one.after === null || (one.before !== null && one.after > one.before) ? 'raises' : 'cuts'} ${model} ${one.tier} ${one.metric} limit to ${n(one.after)} from ${n(one.before)}`
    : `${lab} changes ${model} rate limits on ${moves.length} tier-and-metric limits (${up} up, ${down} down)`
  return {
    rule: LIMITS_RULE,
    entity_type: 'rate_limit',
    entity_key: `rate_limit:${recipe.id}:${model}`,
    provider: recipe.company as Provider,
    period: dates.later,
    change_type: 'modified',
    before: {
      model,
      summary: `${lab} ${model} rate limits · ${dates.earlier}`,
      as_of: dates.earlier,
    },
    after: {
      model,
      summary: `${lab} ${model} rate limits · ${moves.length} changed · ${dates.later}`,
      as_of: dates.later,
      limits_moved: moves.length,
      moved: `${listed}${more}`,
    },
    headline,
    explanation: [
      `${lab} published different ${model} rate limits on ${dates.later} than on ${dates.earlier}: ${listed}${more}.`,
      'These are the limits in the lab’s own docs. They reflect tier design and abuse control as much as capacity.',
      `Rule-based: a published limit, in both snapshots, that moved ${MOVE_PCT}% or more or went to or from no limit. New and retired models and tiers don’t count. No model in the loop.`,
    ].join(' '),
    source_url: newest.source_url,
    fetched_at: newest.fetched_at,
  }
}

/** Pure: the findings for every lab page whose newest snapshot is fresh. */
export function limitFindings(rows: readonly Row[], now: Date): Finding[] {
  return RATE_LIMIT_RECIPES.flatMap((recipe) => {
    const mine = rows.filter((r) => r.recipe_id === recipe.id)
    const dates = [...new Set(mine.map((r) => r.date))].sort()
    const later = dates.at(-1)
    const earlier = dates.at(-2)
    if (!later || !earlier) return []
    if (now.getTime() - Date.parse(`${later}T00:00:00Z`) > FRESH_DAYS * DAY_MS) return []
    const at = (d: string) => mine.filter((r) => r.date === d)
    const newest = at(later).reduce((a, b) => (b.fetched_at > a.fetched_at ? b : a))
    return [...limitMoves(at(earlier), at(later))].map(([model, moves]) =>
      finding(recipe, model, moves, { earlier, later }, newest),
    )
  })
}

interface LimitsAlertReport {
  written: number
  findings: number
}

export async function writeLimitsAlerts(
  db: PipelineDb,
  now = new Date(),
): Promise<LimitsAlertReport> {
  const rows = await db
    .select()
    .from(tables.recipeObservations)
    .where(
      inArray(
        tables.recipeObservations.recipe_id,
        RATE_LIMIT_RECIPES.map((r) => r.id),
      ),
    )
  const findings = limitFindings(rows, now)
  return { written: await writeFindings(db, findings, now), findings: findings.length }
}
