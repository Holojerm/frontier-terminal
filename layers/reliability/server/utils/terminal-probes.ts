// GET /api/probes and the get_probes MCP tool: the hourly latency probes as a
// strain reading per lab. Reads the daily rollup (probe_days) and each lab's
// newest probe, never the raw quarter. A lab's days are the pinned series
// (PRIMARY_PLACEMENT) only; every other placement, and the unpinned probes
// from before placement, is served beside it as a series of its own.

import { desc, eq, gte, max, min } from 'drizzle-orm'

import { medianOf } from '../../shared/utils/terminal-reliability'
import { LAB_DISPLAY } from '#layers/core/shared/utils/lab-names'
import type { LabId } from '../../../core/shared/types/common'
import type {
  ProbeDayView,
  ProbeLabView,
  ProbeSeriesView,
  ProbeWindowView,
  ProbesData,
} from '../../shared/types/probes'

import * as tables from '#server/db/schema'
import type { ProbeDayRow } from '#server/db/schema'
import { peakToOffpeak, strainedShare } from '../pipeline/probes/daily'
import {
  PRIMARY_PLACEMENT,
  PROBE_PLACEMENTS,
  UNPINNED,
  placementLabel,
} from '../pipeline/probes/placement'
import {
  PROBE_ENDPOINT,
  PROBE_GAPS,
  PROBE_MAX_TOKENS,
  PROBE_PROMPT,
  PROBE_ROUTE,
  PROBE_TARGETS,
  PROBE_WINDOWS,
  type ProbeTargetSpec,
} from '../pipeline/probes/targets'
import type { PipelineDb } from '#layers/core/server/utils/pipeline-store'
import { MODEL_CLASS_MAP } from '#layers/pricing/server/utils/terminal-classes'
import type { QueryContext } from '#layers/core/server/utils/terminal-db'

export const PROBE_WINDOW_DAYS = 7
export const PROBE_HISTORY_DAYS = 90

export const PROBES_METHOD =
  'Once an hour we send each lab’s flagship model the same short request through OpenRouter, pinned to the lab’s own endpoint with no fallback, and time the streamed reply. ' +
  'The flagship is the one in our price matrix. Before every run we look it up in our latest copy of OpenRouter’s model list and take its newest point release. When a lab ships one, the probes move to it, and each day’s reading names the model it was measured on. ' +
  'Time to first token runs from sending the request to the first text of the answer, so it includes any reasoning the model does first. Tokens per second is the answer’s tokens over the time between its first and last token, with reasoning tokens left out. ' +
  'Every request caps the reply at the same length. Meta’s and Mistral’s carry a larger cap, because those endpoints count reasoning against it, so their answers can run longer. ' +
  'A day’s reading is the median of its working-hours probes against the median of its night probes, in fixed UTC hours per lab, and the share of probes that were rate limited, errored, or timed out. ' +
  'A window needs three good probes for a median. Probes that failed because of our key or the router aren’t counted.'

export const PROBES_CAVEAT =
  'This is a reading of strain at one hourly sample, from one account, through one router. It isn’t utilization, and we haven’t shown that it predicts anything. ' +
  'An hourly probe misses short bursts of rate limiting. Six of these models reason before they answer, each for as long as it chooses, so compare a lab with its own history and not with another lab. ' +
  `Every probe leaves from one place, a Cloudflare data center in ${placementLabel(PRIMARY_PLACEMENT)}, and the row says which. ` +
  'Probes from before that left from whichever data center ran them, so their times include the distance to the router. They are kept apart, never mixed into the reading.'

const DAY_MS = 86_400_000
const dayOf = (at: Date) => at.toISOString().slice(0, 10)

function dayView(row: ProbeDayRow, today: string): ProbeDayView {
  return {
    day: row.day,
    complete: row.day < today,
    placement: row.placement,
    model: row.model,
    probes: row.probes,
    ok: row.ok,
    rate_limited: row.rate_limited,
    failed: row.failed,
    strained_share: strainedShare(row),
    peak_tps: row.peak_tps,
    offpeak_tps: row.offpeak_tps,
    peak_to_offpeak: peakToOffpeak(row),
    peak_ttft_ms: row.peak_ttft_ms,
    offpeak_ttft_ms: row.offpeak_ttft_ms,
    source_url: row.source_url,
    fetched_at: row.fetched_at,
  }
}

/** The trailing window over complete days on the newest model; null with none. */
export function probeWindow(days: readonly ProbeDayView[], from: string): ProbeWindowView | null {
  const model = days[0]?.model
  const inWindow = days.filter((d) => d.complete && d.day >= from && d.model === model)
  if (inWindow.length === 0) return null
  const sum = (pick: (d: ProbeDayView) => number) => inWindow.reduce((n, d) => n + pick(d), 0)
  const medians = (pick: (d: ProbeDayView) => number | null) =>
    medianOf(inWindow.map(pick).filter((v): v is number => v !== null))
  const totals = {
    probes: sum((d) => d.probes),
    rate_limited: sum((d) => d.rate_limited),
    failed: sum((d) => d.failed),
    peak_tps: medians((d) => d.peak_tps),
    offpeak_tps: medians((d) => d.offpeak_tps),
  }
  return {
    days: inWindow.length,
    ...totals,
    strained_share: strainedShare(totals),
    peak_to_offpeak: peakToOffpeak(totals),
  }
}

/** Parsed rate-limit headers, or null when there were none or the stored text isn't an object. */
function headersOf(text: string | null): Record<string, string> | null {
  if (!text) return null
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, string>)
      : null
  } catch {
    return null
  }
}

/** Pinned placements in PROBE_PLACEMENTS order after the primary, then unpinned, then anything else stored. */
function seriesOrder(placement: string): number {
  if (placement === UNPINNED) return PROBE_PLACEMENTS.length
  const i = PROBE_PLACEMENTS.indexOf(placement as (typeof PROBE_PLACEMENTS)[number])
  return i === -1 ? PROBE_PLACEMENTS.length + 1 : i
}

/** Changes whenever a probe is stored: the cache key beside the poll stamp. */
export async function probesStamp(db: PipelineDb): Promise<string> {
  const [row] = await db
    .select({ at: max(tables.latencyProbes.started_at) })
    .from(tables.latencyProbes)
  return row?.at ?? 'none'
}

/**
 * The model named for a lab no probe has run for yet: a pinned target's id,
 * or for a flagship target the class map's flagship slug, the family the
 * first run picks an id from.
 */
function waitingModel(target: ProbeTargetSpec): string {
  if (target.note !== null) return target.model
  return (
    MODEL_CLASS_MAP.find((e) => e.provider === target.lab && e.class === 'flagship')?.model_slug ??
    target.lab
  )
}

export async function queryProbes(db: PipelineDb, ctx: QueryContext): Promise<ProbesData> {
  const now = ctx.now()
  const today = dayOf(now)
  const historyFrom = dayOf(new Date(now.getTime() - PROBE_HISTORY_DAYS * DAY_MS))
  const windowFrom = dayOf(new Date(now.getTime() - PROBE_WINDOW_DAYS * DAY_MS))
  const p = tables.latencyProbes
  const d = tables.probeDays
  const [dayRows, [first], [firstPinned], latest] = await Promise.all([
    db
      .select()
      .from(tables.probeDays)
      .where(gte(tables.probeDays.day, historyFrom))
      .orderBy(desc(tables.probeDays.day)),
    db.select({ day: min(d.day) }).from(d),
    db
      .select({ day: min(d.day) })
      .from(d)
      .where(eq(d.placement, PRIMARY_PLACEMENT)),
    // One indexed read per lab: a group-by over the table would read every probe ever stored.
    Promise.all(
      PROBE_TARGETS.map((t) =>
        db.select().from(p).where(eq(p.lab, t.lab)).orderBy(desc(p.started_at)).limit(1),
      ),
    ),
  ])
  const newest = new Map(latest.flatMap(([row]) => (row ? [[row.lab, row] as const] : [])))

  const labs = (Object.keys(LAB_DISPLAY) as (LabId | 'other')[])
    .filter((lab): lab is LabId => lab !== 'other')
    .flatMap((lab): ProbeLabView[] => {
      const display = LAB_DISPLAY[lab]
      const target = PROBE_TARGETS.find((t) => t.lab === lab)
      const gap = PROBE_GAPS.find((g) => g.lab === lab)
      if (!target) {
        if (!gap) return []
        return [
          {
            lab,
            display,
            status: 'not_probed',
            model: gap.model,
            model_note: null,
            hours: null,
            gap: gap.reason,
            latest: null,
            window: null,
            days: [],
            other_series: [],
          },
        ]
      }
      const own = dayRows.filter((row) => row.lab === lab).map((row) => dayView(row, today))
      const days = own.filter((row) => row.placement === PRIMARY_PLACEMENT)
      const others = [...new Set(own.map((row) => row.placement))]
        .filter((placement) => placement !== PRIMARY_PLACEMENT)
        .sort((a, b) => seriesOrder(a) - seriesOrder(b))
        .map((placement): ProbeSeriesView => {
          const series = own.filter((row) => row.placement === placement)
          return {
            placement,
            label: placementLabel(placement),
            pinned: placement !== UNPINNED,
            window: probeWindow(series, windowFrom),
            days: series,
          }
        })
      const last = newest.get(lab)
      return [
        {
          lab,
          display,
          status: last ? 'probed' : 'waiting',
          model: last?.model ?? waitingModel(target),
          model_note: target.note,
          hours: PROBE_WINDOWS[target.market].label,
          gap: last ? null : 'No probe has run for this lab yet.',
          latest: last
            ? {
                started_at: last.started_at,
                outcome: last.outcome,
                http_status: last.http_status,
                detail: last.detail,
                ttft_ms: last.ttft_ms,
                total_ms: last.total_ms,
                output_tokens: last.output_tokens,
                tokens_per_second: last.tokens_per_second,
                ran_from: last.ran_from,
                placement: last.placement,
                served_by: last.served_by,
                served_by_pinned: last.served_by_pinned,
                rate_limit_headers: headersOf(last.rate_limit_headers),
                source_url: last.source_url,
                fetched_at: last.fetched_at,
              }
            : null,
          window: probeWindow(days, windowFrom),
          days,
          other_series: others,
        },
      ]
    })

  return {
    as_of: ctx.as_of,
    computed_at: now.toISOString(),
    window_days: PROBE_WINDOW_DAYS,
    history_days: PROBE_HISTORY_DAYS,
    since: first?.day ?? null,
    placement: {
      hint: PRIMARY_PLACEMENT,
      label: placementLabel(PRIMARY_PLACEMENT),
      since: firstPinned?.day ?? null,
    },
    labs,
    probe: {
      endpoint: PROBE_ENDPOINT,
      route: PROBE_ROUTE,
      prompt: PROBE_PROMPT,
      max_tokens: PROBE_MAX_TOKENS,
      cadence: 'hourly',
    },
    method: PROBES_METHOD,
    caveat: PROBES_CAVEAT,
  }
}

/** One lab's slice of the cached all-lab payload, for `/api/probes?lab=`. */
export function probesForLab(data: ProbesData, lab: LabId): ProbesData {
  return { ...data, labs: data.labs.filter((l) => l.lab === lab) }
}
