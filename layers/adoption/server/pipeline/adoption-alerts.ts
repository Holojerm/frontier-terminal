// The adoption rule: an adoption series that moves by more than its own usual week-to-week (or
// month-to-month) noise raises one alert citing the two reads. No model in the loop.
//
// Downloads and GitHub pull requests are read as ISO-week totals, Ramp as monthly shares. Only
// the newest complete period is judged, so a first backfill of history alerts on nothing, and the
// id hashes (series, period), so a re-run alerts on nothing. A series needs MIN_HISTORY earlier
// changes to know its own noise. A week or month counted after the fact (GitHub rows marked
// retrospective) is never compared: the count of pull requests that still exist undercounts old days.

import { and, gte, inArray } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type { PipelineDb } from '#layers/core/server/utils/pipeline-store'
import { LAB_OF_NAME } from '#layers/core/shared/utils/lab-names'
import { count as countLabel } from '#layers/core/shared/utils/terminal-format'
import {
  beyondNoise,
  writeFindings,
  type Finding,
} from '#layers/core/server/pipeline/observation-alerts'
import type { Provider } from '#layers/core/server/utils/contracts'
import { dayRows } from '../recipes/download-series'
import { GITHUB_AGENT_RECIPES } from '../recipes/github-agent-prs'
import { NPM_LAB_RECIPES } from '../recipes/npm-downloads'
import { PYPI_LAB_RECIPES } from '../recipes/pypi-downloads'
import { RAMP_AI_INDEX } from '../recipes/ramp-ai-index'
import { weeklySums } from '../utils/terminal-adoption'

export const ADOPTION_RULE = 'adoption-floor' as const

/** A week's total moves this much (percent) before it can alert, and at least WEEK_NOISE times its usual move. */
export const WEEK_FLOOR_PCT = 25
/** A Ramp vendor's share moves this many points in a month before it can alert. */
export const RAMP_FLOOR_PTS = 2
const NOISE_MULTIPLE = 3
/** Earlier changes the noise is read from: at most this many, and at least MIN_HISTORY of them. */
const HISTORY = 8
const MIN_HISTORY = 4
/** A smaller prior week is a count, not a trend. */
const MIN_PRIOR_TOTAL = 1_000
/** The newest complete week must have ended within this many days, or the series has gone quiet. */
const FRESH_DAYS = 10
/** A Ramp release first stored longer ago than this is not news. */
const RAMP_FRESH_DAYS = 21
const DAY_MS = 86_400_000

interface Week {
  week: string
  total: number
  partial: boolean
  retrospective: boolean
}

export interface WeekMove {
  week: string
  before: number
  after: number
  pct: number
}

/** Pure: the newest complete week against the one before, when the move is out of the series' noise. */
export function weekMove(weeks: readonly Week[], now: Date): WeekMove | null {
  const days = (w: string) => Date.parse(`${w}T00:00:00Z`) / DAY_MS
  const whole = weeks.filter((w) => !w.partial)
  const last = whole.at(-1)
  if (!last || now.getTime() / DAY_MS - days(last.week) > 7 + FRESH_DAYS) return null
  // Consecutive complete weeks ending at `last`; a gap ends the run, so a change never spans one.
  const run = [last]
  for (let i = whole.length - 2; i >= 0 && days(run[0]!.week) - days(whole[i]!.week) === 7; i--) {
    run.unshift(whole[i]!)
  }
  if (run.length < 2 || run.slice(-2).some((w) => w.retrospective)) return null
  const pcts = run
    .slice(1)
    .map((w, i) => (run[i]!.total > 0 ? ((w.total - run[i]!.total) / run[i]!.total) * 100 : null))
  const pct = pcts.at(-1)
  const earlier = pcts.slice(0, -1).filter((p): p is number => p !== null)
  const before = run.at(-2)!
  if (pct === null || pct === undefined || before.total < MIN_PRIOR_TOTAL) return null
  if (earlier.length < MIN_HISTORY) return null
  if (!beyondNoise(pct, earlier.slice(-HISTORY), WEEK_FLOOR_PCT, NOISE_MULTIPLE)) return null
  return { week: last.week, before: before.total, after: last.total, pct }
}

export interface MonthMove {
  month: string
  before: number
  after: number
  points: number
}

/** Pure: a Ramp series' newest month against the one before, when the move is out of its noise. */
export function monthMove(series: readonly { month: string; value: number }[]): MonthMove | null {
  const sorted = [...series].sort((a, b) => (a.month < b.month ? -1 : 1))
  const last = sorted.at(-1)
  const prev = sorted.at(-2)
  if (!last || !prev) return null
  // Ramp dates months by their first day; a skipped month is a gap, not a move.
  const gap = Date.parse(`${last.month}T00:00:00Z`) - Date.parse(`${prev.month}T00:00:00Z`)
  if (gap > 31 * DAY_MS) return null
  const points = sorted.slice(1).map((p, i) => p.value - sorted[i]!.value)
  const change = points.at(-1)!
  const earlier = points.slice(0, -1)
  if (earlier.length < MIN_HISTORY) return null
  if (!beyondNoise(change, earlier.slice(-HISTORY), RAMP_FLOOR_PTS, NOISE_MULTIPLE)) return null
  return { month: last.month, before: prev.value, after: last.value, points: change }
}

type Row = typeof tables.recipeObservations.$inferSelect

const num = (n: number) => (Math.abs(n) >= 1000 ? countLabel(Math.round(n)) : String(Math.round(n)))
const round1 = (n: number) => Math.round(n * 10) / 10
const size = (n: number) => round1(Math.abs(n))

const UNIT: Readonly<Record<string, string>> = {
  npm: 'npm downloads',
  PyPI: 'PyPI downloads',
  github: 'GitHub pull requests',
}

interface SeriesIn {
  recipe_id: string
  provider: Provider
  /** The package ("@anthropic-ai/claude-code") or agent ("Claude Code"). */
  name: string
  kind: keyof typeof UNIT
  rows: Row[]
}

/** The finding for one weekly series, or null. */
export function weeklyFinding(s: SeriesIn, now: Date): Finding | null {
  const rows = s.rows.filter((r) => r.value !== null)
  const points =
    s.kind === 'github'
      ? rows.map((r) => ({
          date: r.date,
          value: r.value!,
          retrospective:
            (JSON.parse(r.payload) as { retrospective?: unknown }).retrospective === true,
        }))
      : dayRows(rows)
          .filter((d) => !d.outage)
          .map((d) => ({ date: d.date, value: d.value }))
  const move = weekMove(weeklySums(points), now)
  if (!move) return null
  const newest = rows.reduce((a, b) => (b.fetched_at > a.fetched_at ? b : a))
  const verb = move.pct > 0 ? 'rise' : 'fall'
  const sunday = new Date(Date.parse(`${move.week}T00:00:00Z`) + 6 * DAY_MS)
    .toISOString()
    .slice(0, 10)
  const unit = UNIT[s.kind]!
  return {
    rule: ADOPTION_RULE,
    entity_type: 'adoption_series',
    entity_key: `adoption_series:${s.recipe_id}`,
    provider: s.provider,
    period: move.week,
    change_type: 'modified',
    before: {
      series: s.recipe_id,
      summary: `${s.name} ${unit} · ${num(move.before)} in the week of ${prevWeek(move.week)}`,
      week: prevWeek(move.week),
      total: move.before,
    },
    after: {
      series: s.recipe_id,
      summary: `${s.name} ${unit} · ${num(move.after)} in the week of ${move.week}`,
      week: move.week,
      total: move.after,
      pct_change: Math.round(move.pct * 100) / 100,
    },
    headline: `${s.name} ${unit} ${verb} ${size(move.pct)}% in the week to ${sunday}, to ${num(move.after)} from ${num(move.before)}`,
    explanation: [
      `${s.name} ${unit} totalled ${num(move.before)} in the week of ${prevWeek(move.week)} and ${num(move.after)} in the week of ${move.week} (${round1(move.pct)}%).`,
      s.kind === 'github'
        ? 'The count is of public pull requests that carry this agent’s trace, so it is not a share of any market.'
        : 'Every download counts, including CI and bots, so read the trend and not the level.',
      `Rule-based: only a complete week, a move of ${WEEK_FLOOR_PCT}% or more that is also at least ${NOISE_MULTIPLE} times the series’ usual week-to-week move over the earlier ${HISTORY} weeks. No model in the loop.`,
    ].join(' '),
    source_url: newest.source_url,
    fetched_at: newest.fetched_at,
  }
}

const prevWeek = (week: string) =>
  new Date(Date.parse(`${week}T00:00:00Z`) - 7 * DAY_MS).toISOString().slice(0, 10)

const monthName = (month: string) =>
  new Date(`${month}T00:00:00Z`).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })

/** The findings for the Ramp AI Index rows, one per series whose newest month moved out of its noise. */
export function rampFindings(rows: readonly Row[], now: Date): Finding[] {
  const current = rows.filter((r) => !r.key.includes('@') && r.value !== null)
  const out: Finding[] = []
  for (const key of new Set(current.map((r) => r.key))) {
    const mine = current.filter((r) => r.key === key)
    const move = monthMove(mine.map((r) => ({ month: r.date, value: r.value! })))
    if (!move) continue
    const newest = mine.find((r) => r.date === move.month)!
    // A month first stored long ago (a deploy over old data) is history, not news.
    if (now.getTime() - Date.parse(newest.first_seen_at) > RAMP_FRESH_DAYS * DAY_MS) continue
    const vendor = (JSON.parse(newest.payload) as { vendor?: string | null }).vendor
    const name = key === 'overall' ? 'Any AI vendor' : (vendor ?? key)
    const lab = LAB_OF_NAME[key]
    const verb = move.points > 0 ? 'rises' : 'falls'
    const month = monthName(move.month)
    out.push({
      rule: ADOPTION_RULE,
      entity_type: 'adoption_series',
      entity_key: `adoption_series:${RAMP_AI_INDEX.id}:${key}`,
      provider: lab ?? 'other',
      period: move.month,
      change_type: 'modified',
      before: {
        series: key,
        summary: `${name} on Ramp · ${round1(move.before)}% of businesses`,
        month: prevMonth(move.month),
        share_pct: round1(move.before),
      },
      after: {
        series: key,
        summary: `${name} on Ramp · ${round1(move.after)}% of businesses · ${month}`,
        month: move.month,
        share_pct: round1(move.after),
        points_change: Math.round(move.points * 100) / 100,
      },
      headline: `${name} adoption among Ramp businesses ${verb} ${size(move.points)} points in ${month}, to ${round1(move.after)}% from ${round1(move.before)}%`,
      explanation: [
        `Ramp’s AI Index puts ${name} at ${round1(move.after)}% of US businesses on Ramp that paid it in ${month}, against ${round1(move.before)}% the month before (${round1(move.points)} points).`,
        'It measures adoption, not spend, and covers Ramp’s customers only. Ramp restates past months between releases.',
        `Rule-based: a move of ${RAMP_FLOOR_PTS} points or more that is also at least ${NOISE_MULTIPLE} times the series’ usual monthly move. No model in the loop.`,
      ].join(' '),
      source_url: newest.source_url,
      fetched_at: newest.fetched_at,
    })
  }
  return out
}

const prevMonth = (month: string) => {
  const d = new Date(`${month}T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() - 1)
  return d.toISOString().slice(0, 10)
}

/** Every weekly adoption series the rule reads. */
function weeklySeries(): Omit<SeriesIn, 'rows'>[] {
  const pkg = (r: { id: string; company: string; description: string }, kind: 'npm' | 'PyPI') => ({
    recipe_id: r.id,
    provider: (r.company in LAB_OF_NAME || r.company === 'frontier-labs'
      ? r.company
      : 'other') as Provider,
    name: /^Daily \S+ downloads of (\S+),/.exec(r.description)?.[1] ?? r.id,
    kind,
  })
  return [
    ...NPM_LAB_RECIPES.map((r) => pkg(r, 'npm')),
    ...PYPI_LAB_RECIPES.map((r) => pkg(r, 'PyPI')),
    ...GITHUB_AGENT_RECIPES.map((r) => ({
      recipe_id: r.id,
      provider: r.company as Provider,
      name: r.description.replace(/^.* from (.+?) \(search.*$/, '$1'),
      kind: 'github' as const,
    })),
  ]
}

interface AdoptionAlertReport {
  written: number
  findings: number
}

/** Read the stored series and write any new alert. */
export async function writeAdoptionAlerts(
  db: PipelineDb,
  now = new Date(),
): Promise<AdoptionAlertReport> {
  const series = weeklySeries()
  const since = new Date(now.getTime() - 120 * DAY_MS).toISOString().slice(0, 10)
  const rows = await db
    .select()
    .from(tables.recipeObservations)
    .where(
      and(
        inArray(
          tables.recipeObservations.recipe_id,
          series.map((s) => s.recipe_id),
        ),
        gte(tables.recipeObservations.date, since),
      ),
    )
  const findings = series.flatMap((s) => {
    const mine = rows.filter((r) => r.recipe_id === s.recipe_id)
    return mine.length ? [weeklyFinding({ ...s, rows: mine }, now)] : []
  })
  const ramp = await db
    .select()
    .from(tables.recipeObservations)
    .where(inArray(tables.recipeObservations.recipe_id, [RAMP_AI_INDEX.id]))
  const all = [...findings.filter((f): f is Finding => f !== null), ...rampFindings(ramp, now)]
  return { written: await writeFindings(db, all, now), findings: all.length }
}
