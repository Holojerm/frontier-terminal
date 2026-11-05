// The /api/reliability payload (/data#reliability): how each source's checks
// went, when the site's data was older than we say it is, how fast a filing
// reached an alert, and each deploy's smoke test. Every figure is computed
// here from stored rows: the daily rollup and poll ticks, filing detections,
// and deploy checks (layers/terminal/server/pipeline/reliability/), plus the
// corrections log. Reads are bounded by the 90-day window on indexed columns.

import { and, desc, eq, gte, inArray, max, min, sql } from 'drizzle-orm'

import { CORRECTIONS } from '../../shared/utils/corrections'
import {
  DETECTION_RULES,
  FRESHNESS_LANES,
  RELIABILITY_DAYS,
  medianOf,
  minutesBetween,
  type DeployCheck,
  type FilingDetection,
  type FreshnessLane,
  type ReliabilityData,
  type RunGap,
  type SourceReliability,
  type StalePeriod,
} from '../../shared/utils/terminal-reliability'
import type { ProviderId, SourceAxis } from '../../shared/utils/terminal-types'

import * as tables from '#server/db/schema'
import { manifestFixtures } from '../pipeline/parsers/fixture-provenance'
import { filingIndexUrl, releasedAt } from '../pipeline/reliability/acceptance'
import { ROLLUP_NAME, addDays, dayOf } from '../pipeline/reliability/rollup'
import { statedIntervalMinutes } from '../pipeline/scopes'
import type { PipelineDb } from '../pipeline/store'
import type { QueryContext } from './terminal-db'
import { PROVIDER_ORDER, derivedTemplateOf, labelOf } from './terminal-sources'

/** Stale periods listed per lane, newest first; the totals count them all. */
const PERIODS_SHOWN = 50
/** Deploy checks listed; the window rarely holds more. */
const DEPLOYS_SHOWN = 300
/** A source still failing counts as an open gap once it is this many intervals overdue. */
const OPEN_GAP_INTERVALS = 2

/** The rollup is still catching up while it is more than this far behind now. */
export const BUILDING_LAG_MS = 60 * 60 * 1000

/** A cache variant: how far the rollup has rolled, the newest deploy read and filing record, which the poll stamp does not see. */
export async function reliabilityStamp(db: PipelineDb): Promise<string> {
  const [[t], [d], [f]] = await Promise.all([
    db
      .select({ at: tables.rollupState.rolled_through })
      .from(tables.rollupState)
      .where(eq(tables.rollupState.name, ROLLUP_NAME)),
    db.select({ at: max(tables.deployChecks.fetched_at) }).from(tables.deployChecks),
    db.select({ at: max(tables.filingDetections.recorded_at) }).from(tables.filingDetections),
  ])
  return `${t?.at ?? 'none'}|${d?.at ?? 'none'}|${f?.at ?? 'none'}`
}

export interface ReliabilityOptions {
  /** The commit this deploy runs (runtimeConfig.public.buildSha). */
  buildSha: string | null
  /** fleet.json links.github, for the workflow's page. */
  repoUrl: string
  /** The GitHub API page the deploy checks are read from. */
  runsUrl: string
}

interface SourceTotals {
  source_id: string
  runs: number
  good: number
  runs_short: number
  good_short: number
  last_good_at: string | null
  last_run_at: string
  first_day: string
}

async function sourceTotals(db: PipelineDb, longFrom: string, shortFrom: string) {
  const d = tables.sourceRunDays
  const gapRank = db
    .select({
      source_id: d.source_id,
      longest_gap_ms: d.longest_gap_ms,
      gap_from: d.gap_from,
      gap_to: d.gap_to,
      rank: sql<number>`row_number() over (partition by ${d.source_id} order by ${d.longest_gap_ms} desc, ${d.day} desc)`.as(
        'rank',
      ),
    })
    .from(d)
    .where(and(gte(d.day, longFrom), sql`${d.longest_gap_ms} is not null`))
    .as('gap_rank')
  const [totals, gaps] = await Promise.all([
    db
      .select({
        source_id: d.source_id,
        runs: sql<number>`sum(${d.runs})`,
        good: sql<number>`sum(${d.good})`,
        runs_short: sql<number>`sum(case when ${d.day} >= ${shortFrom} then ${d.runs} else 0 end)`,
        good_short: sql<number>`sum(case when ${d.day} >= ${shortFrom} then ${d.good} else 0 end)`,
        last_good_at: max(d.last_good_at),
        last_run_at: max(d.last_run_at),
        first_day: min(d.day),
      })
      .from(d)
      .where(gte(d.day, longFrom))
      .groupBy(d.source_id),
    db
      .select({
        source_id: gapRank.source_id,
        longest_gap_ms: gapRank.longest_gap_ms,
        gap_from: gapRank.gap_from,
        gap_to: gapRank.gap_to,
      })
      .from(gapRank)
      .where(sql`${gapRank.rank} = 1`),
  ])
  return {
    totals: totals as SourceTotals[],
    gaps: new Map(gaps.map((g) => [g.source_id, g])),
  }
}

/**
 * The longer of the longest closed gap and one still open at `through` (how
 * far the rollup has counted, never past it). A gap is open only while the
 * source is still being checked and failing: a page we stopped deriving (a
 * delisted model) isn't waiting for anything.
 */
function longestGap(
  closed:
    | { longest_gap_ms: number | null; gap_from: string | null; gap_to: string | null }
    | undefined,
  totals: Pick<SourceTotals, 'last_good_at' | 'last_run_at'> | undefined,
  statedMinutes: number,
  through: string,
): RunGap | null {
  const gap: RunGap | null =
    closed?.longest_gap_ms != null && closed.gap_from && closed.gap_to
      ? {
          minutes: Math.round(closed.longest_gap_ms / 6000) / 10,
          from: closed.gap_from,
          to: closed.gap_to,
        }
      : null
  const lastGood = totals?.last_good_at ?? null
  if (!lastGood || !totals || totals.last_run_at <= lastGood) return gap
  const open = minutesBetween(lastGood, through)
  if (open < statedMinutes * OPEN_GAP_INTERVALS || (gap && gap.minutes >= open)) return gap
  return { minutes: open, from: lastGood, to: null }
}

function derivedProvider(id: string): ProviderId | 'all' {
  if (id.startsWith('openai-')) return 'openai'
  if (id.startsWith('google-')) return 'google'
  return PROVIDER_ORDER.find((p) => id.endsWith(`-${p}`)) ?? 'all'
}

function derivedAxis(template: string): SourceAxis {
  if (template === 'openai-model-md' || template === 'google-model-md') return 'pricing-catalog'
  if (template === 'openai-misalignment-report') return 'disclosures'
  if (template === 'edgar-companyfacts') return 'revenue'
  return 'sec'
}

const ratio = (t: { runs: number; good: number } | null) => (t?.runs ? t.good / t.runs : 1)

/** Worst first: lowest share of good runs in the long window, then the longest gap. Never-checked rows last. */
function worstFirst(a: SourceReliability, b: SourceReliability): number {
  if (!a.long?.runs !== !b.long?.runs) return a.long?.runs ? -1 : 1
  return (
    ratio(a.long) - ratio(b.long) ||
    ratio(a.short) - ratio(b.short) ||
    (b.longest_gap?.minutes ?? 0) - (a.longest_gap?.minutes ?? 0) ||
    a.source_id.localeCompare(b.source_id)
  )
}

async function sourceRows(
  db: PipelineDb,
  ctx: QueryContext,
  longFrom: string,
  shortFrom: string,
  /** Where the rollup has counted to; null while it is still building. */
  through: string | null,
): Promise<{ rows: SourceReliability[]; first_day: string | null }> {
  const { totals, gaps } = await sourceTotals(db, longFrom, shortFrom)
  const byId = new Map(totals.map((t) => [t.source_id, t]))
  const row = (
    source_id: string,
    base: Omit<
      SourceReliability,
      'short' | 'long' | 'longest_gap' | 'last_good_at' | 'stated_minutes'
    >,
    members: readonly string[],
  ): SourceReliability => {
    const stated = statedIntervalMinutes(members[0] ?? source_id)
    const own = members.map((id) => byId.get(id)).filter((t): t is SourceTotals => t !== undefined)
    const sum = (k: 'runs' | 'good' | 'runs_short' | 'good_short') =>
      own.reduce((n, t) => n + Number(t[k] ?? 0), 0)
    const lastGood =
      own
        .map((t) => t.last_good_at)
        .filter((x): x is string => x !== null)
        .sort()
        .at(-1) ?? null
    // A group's gap is its worst member's.
    const memberGaps = through
      ? members
          .map((id) => longestGap(gaps.get(id), byId.get(id), stated, through))
          .filter((g): g is RunGap => g !== null)
          .sort((a, b) => b.minutes - a.minutes)
      : []
    // A window's tally is shown only once the rollup covers all of it.
    return {
      ...base,
      source_id,
      stated_minutes: stated,
      short: through ? { runs: sum('runs_short'), good: sum('good_short') } : null,
      long: through ? { runs: sum('runs'), good: sum('good') } : null,
      longest_gap: memberGaps[0] ?? null,
      last_good_at: lastGood,
    }
  }

  const registered = new Set(ctx.registry.sources.map((s) => s.source_id))
  const rows = ctx.registry.sources.map((s) =>
    row(
      s.source_id,
      {
        source_id: s.source_id,
        label: labelOf(s.source_id).label,
        provider: s.provider,
        axis: s.axis,
        url: manifestFixtures.find((f) => f.source_id === s.source_id)?.source_url ?? s.url,
        members: 0,
      },
      [s.source_id],
    ),
  )
  // Derived sources (per-model pages, per-filing indexes) are folded into
  // one row per template; a template with one member keeps that member's row.
  const templates = new Map<string, string[]>()
  for (const id of [...byId.keys()].sort()) {
    const template = registered.has(id) ? null : derivedTemplateOf(id)
    if (template) templates.set(template, [...(templates.get(template) ?? []), id])
  }
  for (const [template, members] of templates) {
    const single = members.length === 1
    const first = members[0]!
    const label = single
      ? labelOf(first).label
      : `${labelOf(first).label.replace(/\s*\(.*\)$/, '')}s (${members.length})`
    rows.push(
      row(
        single ? first : template,
        {
          source_id: single ? first : template,
          label,
          provider: derivedProvider(first),
          axis: derivedAxis(template),
          url: '',
          members: single ? 0 : members.length,
        },
        members,
      ),
    )
  }
  const firstDay = totals.map((t) => t.first_day).sort()[0] ?? null
  return { rows: rows.sort(worstFirst), first_day: firstDay }
}

/**
 * Stale periods per lane, from ticks before `through`. Without a `through`
 * (the rollup is still building) only closed periods are listed: the time
 * after the last rolled tick is unread, not stale.
 */
async function freshnessLanes(
  db: PipelineDb,
  longFromIso: string,
  through: string | null,
): Promise<FreshnessLane[]> {
  const t = tables.pollTicks
  return Promise.all(
    FRESHNESS_LANES.map(async (lane): Promise<FreshnessLane> => {
      // A check counts when most of its sources answered.
      const counted = and(
        gte(t.started_at, longFromIso),
        inArray(t.scope, [...lane.scopes]),
        sql`${t.good} * 2 > ${t.runs}`,
      )
      const seq = db
        .select({
          started_at: t.started_at,
          prev: sql<string | null>`lag(${t.started_at}) over (order by ${t.started_at})`.as('prev'),
        })
        .from(t)
        .where(counted)
        .as('seq')
      const limit = lane.stated_minutes + lane.grace_minutes
      const [gaps, [span]] = await Promise.all([
        db
          .select({ to: seq.started_at, from: seq.prev })
          .from(seq)
          .where(
            sql`${seq.prev} is not null and (julianday(${seq.started_at}) - julianday(${seq.prev})) * 1440 > ${limit}`,
          ),
        db
          .select({ n: sql<number>`count(*)`, first: min(t.started_at), last: max(t.started_at) })
          .from(t)
          .where(counted),
      ])
      const stale = (from: string, to: string | null): StalePeriod => {
        const due = new Date(Date.parse(from) + lane.stated_minutes * 60_000).toISOString()
        return { from: due, to, minutes: minutesBetween(due, to ?? through ?? due) }
      }
      const periods = gaps.map((g) => stale(g.from!, g.to))
      if (through && span?.last && minutesBetween(span.last, through) > limit) {
        periods.push(stale(span.last, null))
      }
      periods.sort((a, b) => b.from.localeCompare(a.from))
      return {
        id: lane.id,
        label: lane.label,
        stated_minutes: lane.stated_minutes,
        grace_minutes: lane.grace_minutes,
        from: span?.first ?? null,
        checks: Number(span?.n ?? 0),
        stale_minutes: Math.round(periods.reduce((n, p) => n + p.minutes, 0) * 10) / 10,
        periods: periods.slice(0, PERIODS_SHOWN),
      }
    }),
  )
}

async function detections(db: PipelineDb): Promise<ReliabilityData['detection']> {
  const rows = await db
    .select()
    .from(tables.filingDetections)
    .orderBy(desc(tables.filingDetections.alerted_at))
  const out: FilingDetection[] = rows.map((r) => {
    const released = r.accepted_at ? releasedAt(r.accepted_at, r.filing_date) : null
    return {
      accession_no: r.accession_no,
      cik: r.cik,
      form: r.form,
      alert_id: r.alert_id,
      rule: r.rule,
      headline: r.headline,
      alerted_at: r.alerted_at,
      accepted_at: r.accepted_at,
      filing_date: r.filing_date,
      released_at: released,
      minutes_from_acceptance: r.accepted_at ? minutesBetween(r.accepted_at, r.alerted_at) : null,
      minutes_from_release: released ? minutesBetween(released, r.alerted_at) : null,
      basis: r.basis === 'submissions' || r.basis === 'filing-index' ? r.basis : null,
      source_url: r.source_url,
      fetched_at: r.fetched_at,
      filing_url: filingIndexUrl(r.cik, r.accession_no),
    }
  })
  const summary = (k: 'minutes_from_acceptance' | 'minutes_from_release') => {
    const values = out.map((r) => r[k]).filter((v): v is number => v !== null)
    return {
      median_minutes: medianOf(values),
      worst_minutes: values.length ? Math.max(...values) : null,
    }
  }
  return {
    rules: DETECTION_RULES,
    from: out.at(-1)?.alerted_at ?? null,
    rows: out,
    acceptance: summary('minutes_from_acceptance'),
    release: summary('minutes_from_release'),
    missing: out.filter((r) => r.accepted_at === null).length,
  }
}

async function deploys(
  db: PipelineDb,
  longFromIso: string,
  opts: ReliabilityOptions,
): Promise<ReliabilityData['deploys']> {
  const d = tables.deployChecks
  const [rows, [span]] = await Promise.all([
    db
      .select({
        run_id: d.run_id,
        head_sha: d.head_sha,
        status: d.status,
        conclusion: d.conclusion,
        created_at: d.created_at,
        updated_at: d.updated_at,
        html_url: d.html_url,
      })
      .from(d)
      .where(gte(d.created_at, longFromIso))
      .orderBy(desc(d.created_at))
      .limit(DEPLOYS_SHOWN),
    db.select({ first: min(d.created_at), fetched: max(d.fetched_at) }).from(d),
  ])
  const checks: DeployCheck[] = rows
  const tally = { success: 0, failure: 0, cancelled: 0, other: 0, running: 0 }
  for (const r of checks) {
    if (r.status !== 'completed') tally.running++
    else if (r.conclusion === 'success') tally.success++
    else if (r.conclusion === 'failure' || r.conclusion === 'timed_out') tally.failure++
    else if (r.conclusion === 'cancelled') tally.cancelled++
    else tally.other++
  }
  return {
    workflow_url: `${opts.repoUrl.replace(/\/$/, '')}/actions/workflows/post-deploy-smoke.yml?query=branch%3Amain`,
    source_url: opts.runsUrl,
    fetched_at: span?.fetched ?? null,
    from: span?.first ?? null,
    rows: checks,
    tally,
    build_sha: opts.buildSha || null,
  }
}

export async function queryReliability(
  db: PipelineDb,
  ctx: QueryContext,
  opts: ReliabilityOptions,
): Promise<ReliabilityData> {
  const nowDate = ctx.now()
  const now = nowDate.toISOString()
  const today = dayOf(now)
  const longFrom = addDays(today, 1 - RELIABILITY_DAYS.long)
  const shortFrom = addDays(today, 1 - RELIABILITY_DAYS.short)
  const longFromIso = `${longFrom}T00:00:00.000Z`

  const [state] = await db
    .select()
    .from(tables.rollupState)
    .where(eq(tables.rollupState.name, ROLLUP_NAME))
  const rolledThrough = state?.rolled_through ?? null
  // Until the rollup has caught up, the time after rolled_through is unread,
  // not stale, so no gap, stale period or window tally reaches past it.
  const building =
    rolledThrough === null || nowDate.getTime() - Date.parse(rolledThrough) > BUILDING_LAG_MS
  const through = building ? null : rolledThrough

  const [sources, freshness, detection, deploy] = await Promise.all([
    sourceRows(db, ctx, longFrom, shortFrom, through),
    freshnessLanes(db, longFromIso, through),
    detections(db),
    deploys(db, longFromIso, opts),
  ])
  const corrections = [...CORRECTIONS].sort((a, b) => b.on.localeCompare(a.on))
  return {
    as_of: ctx.as_of,
    computed_at: now,
    days: RELIABILITY_DAYS,
    building: building ? { rolled_through: rolledThrough, started: state?.started ?? null } : null,
    sources: { rolled_through: rolledThrough, ...sources },
    freshness,
    detection,
    deploys: deploy,
    corrections: {
      count: corrections.length,
      latest: corrections[0] ?? null,
      url: '/about#corrections',
    },
  }
}
