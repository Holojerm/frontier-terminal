// The daily strain reading: one lab's probes for one UTC day, reduced to how
// often a probe was rate limited or failed and how throughput in the lab's
// working hours compares with its night. Rolled into probe_days after every
// run for the days that run touched, one row per placement: probes that left
// from different places are never one reading (pipeline/probes/placement.ts).

import { and, gte, lt, sql } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { EXCLUDED_OUTCOMES, type ProbeOutcome } from './stream'
import { PROBE_TARGETS, PROBE_WINDOWS, type ProbeTargetSpec, type ProbeWindow } from './targets'

/** A window's median needs this many ok probes; under it the reading is null, never a guess from one or two. */
export const MIN_WINDOW_SAMPLES = 3

export interface ProbePoint {
  started_at: string
  model: string
  route: string
  outcome: string
  ttft_ms: number | null
  tokens_per_second: number | null
  source_url: string
}

export interface DayReading {
  model: string
  route: string
  probes: number
  ok: number
  rate_limited: number
  failed: number
  excluded: number
  peak_n: number
  offpeak_n: number
  peak_tps: number | null
  offpeak_tps: number | null
  peak_ttft_ms: number | null
  offpeak_ttft_ms: number | null
  tps: number | null
  ttft_ms: number | null
  source_url: string
  /** The day's newest probe. */
  fetched_at: string
}

const values = (points: readonly ProbePoint[], pick: (p: ProbePoint) => number | null) =>
  points.map(pick).filter((v): v is number => v !== null)

const windowMedian = (points: readonly ProbePoint[], pick: (p: ProbePoint) => number | null) => {
  const v = values(points, pick)
  return v.length >= MIN_WINDOW_SAMPLES ? medianOf(v) : null
}

/** One lab's reading for one day; null when it has no probes that day. */
export function dayReading(all: readonly ProbePoint[], window: ProbeWindow): DayReading | null {
  if (all.length === 0) return null
  const newest = all.reduce((a, b) => (b.started_at > a.started_at ? b : a))
  // A day that changed model reads from the newest model only: two models' speeds are not one series.
  const points = all.filter((p) => p.model === newest.model && p.route === newest.route)
  const excluded = points.filter((p) =>
    EXCLUDED_OUTCOMES.includes(p.outcome as ProbeOutcome),
  ).length
  const ok = points.filter((p) => p.outcome === 'ok')
  const rate_limited = points.filter((p) => p.outcome === 'rate_limited').length
  const hour = (p: ProbePoint) => new Date(p.started_at).getUTCHours()
  const peak = ok.filter((p) => window.peak.includes(hour(p)))
  const offpeak = ok.filter((p) => window.offpeak.includes(hour(p)))
  const tps = (p: ProbePoint) => p.tokens_per_second
  const ttft = (p: ProbePoint) => p.ttft_ms
  return {
    model: newest.model,
    route: newest.route,
    probes: points.length - excluded,
    ok: ok.length,
    rate_limited,
    failed: points.length - excluded - ok.length - rate_limited,
    excluded,
    peak_n: values(peak, tps).length,
    offpeak_n: values(offpeak, tps).length,
    peak_tps: windowMedian(peak, tps),
    offpeak_tps: windowMedian(offpeak, tps),
    peak_ttft_ms: windowMedian(peak, ttft),
    offpeak_ttft_ms: windowMedian(offpeak, ttft),
    tps: medianOf(values(ok, tps)),
    ttft_ms: medianOf(values(ok, ttft)),
    source_url: newest.source_url,
    fetched_at: newest.started_at,
  }
}

/** Share of a reading's probes that were rate limited or failed; null with none to count. */
export function strainedShare(r: { probes: number; rate_limited: number; failed: number }) {
  return r.probes > 0 ? Math.round(((r.rate_limited + r.failed) / r.probes) * 1000) / 1000 : null
}

/** Peak throughput over off-peak: under 1 means slower in working hours. Null unless both windows have a median. */
export function peakToOffpeak(r: { peak_tps: number | null; offpeak_tps: number | null }) {
  return r.peak_tps !== null && r.offpeak_tps !== null && r.offpeak_tps > 0
    ? Math.round((r.peak_tps / r.offpeak_tps) * 1000) / 1000
    : null
}

const nextDay = (day: string) =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10)

/** Re-roll probe_days for each of `days` (YYYY-MM-DD, UTC) from the stored probes. Returns rows written. */
export async function rollProbeDays(
  db: PipelineDb,
  days: readonly string[],
  now: Date,
  targets: readonly Pick<ProbeTargetSpec, 'lab' | 'market'>[] = PROBE_TARGETS,
): Promise<number> {
  const p = tables.latencyProbes
  const d = tables.probeDays
  const rolled_at = now.toISOString()
  const rows: (typeof d.$inferInsert)[] = []
  for (const day of new Set(days)) {
    const probes = await db
      .select({
        lab: p.lab,
        placement: p.placement,
        started_at: p.started_at,
        model: p.model,
        route: p.route,
        outcome: p.outcome,
        ttft_ms: p.ttft_ms,
        tokens_per_second: p.tokens_per_second,
        source_url: p.source_url,
      })
      .from(p)
      .where(and(gte(p.started_at, day), lt(p.started_at, nextDay(day))))
    for (const target of targets) {
      const own = probes.filter((row) => row.lab === target.lab)
      for (const placement of new Set(own.map((row) => row.placement))) {
        const reading = dayReading(
          own.filter((row) => row.placement === placement),
          PROBE_WINDOWS[target.market],
        )
        if (reading) rows.push({ lab: target.lab, day, placement, ...reading, rolled_at })
      }
    }
  }
  if (rows.length === 0) return 0
  await runStatements(
    db,
    chunk(rows, rowsPerStatement(Object.keys(rows[0]!).length)).map((group) =>
      db
        .insert(d)
        .values(group)
        .onConflictDoUpdate({
          target: [d.lab, d.day, d.placement],
          set: {
            model: sql`excluded.model`,
            route: sql`excluded.route`,
            probes: sql`excluded.probes`,
            ok: sql`excluded.ok`,
            rate_limited: sql`excluded.rate_limited`,
            failed: sql`excluded.failed`,
            excluded: sql`excluded.excluded`,
            peak_n: sql`excluded.peak_n`,
            offpeak_n: sql`excluded.offpeak_n`,
            peak_tps: sql`excluded.peak_tps`,
            offpeak_tps: sql`excluded.offpeak_tps`,
            peak_ttft_ms: sql`excluded.peak_ttft_ms`,
            offpeak_ttft_ms: sql`excluded.offpeak_ttft_ms`,
            tps: sql`excluded.tps`,
            ttft_ms: sql`excluded.ttft_ms`,
            rolled_at: sql`excluded.rolled_at`,
            source_url: sql`excluded.source_url`,
            fetched_at: sql`excluded.fetched_at`,
          },
        }),
    ),
  )
  return rows.length
}
