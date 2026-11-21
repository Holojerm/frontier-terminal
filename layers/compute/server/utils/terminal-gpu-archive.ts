// Reads of archived GPU prices (archived_gpu_prices, backfilled by
// scripts/wayback-backfill.ts --axis gpu). Kept out of the live derivations:
// gpuState, the median floor, the Compute thesis and the alerts.

import { asc, eq } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import {
  GPU_ARCHIVE_GAPS,
  GPU_ARCHIVE_NOT_COVERED,
  GPU_ARCHIVE_UNTIL,
} from '../pipeline/archive/gpu-eras'
import { gpuMedian, type GpuObservation } from '../recipes/gpu-series'
import { GPU_MODELS, gpuPricePayload } from '../recipes/gpu-prices'

/** A provider's newest copy counts toward a week's median for this long, then drops out. */
export const GPU_ARCHIVE_STALE_DAYS = 90

export const GPU_ARCHIVE_METHOD =
  'Before our first read of each provider’s price page, the history comes from the Internet Archive’s copies of the same page (source_id wayback:<era>). We read one copy a week, with the parser for the layout the page had then, and count its rows the way the live median does. That is event time (when the Archive saw the page), not knowledge time: we read the copies back long after, at fetched_at. ' +
  `Each week’s median takes every provider’s newest copy from that week or the ${GPU_ARCHIVE_STALE_DAYS} days before it, so it moves when a provider’s copies start or stop, with no price changing. ` +
  'Archived prices never reach the Compute thesis, its median floor, alerts or the judge.'

const DAY_MS = 86_400_000
const dayOf = (iso: string) => iso.slice(0, 10)
const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)

/** One parsed capture, as the read side holds it. */
export interface ArchivedGpuCapture {
  provider: string
  capture_id: string
  captured_at: string
  source_url: string
  fetched_at: string
  observations: GpuObservation[]
}

/**
 * Pure: the weekly medians over every provider's archived copies. A week
 * (ending on each date) takes each provider's newest copy at or before it,
 * if that copy is no more than GPU_ARCHIVE_STALE_DAYS old.
 */
export function archivedGpuSeries(
  captures: readonly ArchivedGpuCapture[],
  liveFrom: string,
): Pick<GpuArchiveView, 'dates' | 'gpus'> {
  const sorted = [...captures].sort((a, b) => byString(a.captured_at, b.captured_at))
  const first = sorted[0]
  if (!first)
    return { dates: [], gpus: GPU_MODELS.map((gpu) => ({ gpu, median: [], providers: [] })) }
  const dates: string[] = []
  for (let d = dayOf(first.captured_at); d < liveFrom; d = addDays(d, 7)) dates.push(d)
  const byProvider = new Map<string, ArchivedGpuCapture[]>()
  for (const c of sorted) byProvider.set(c.provider, [...(byProvider.get(c.provider) ?? []), c])
  const reads = dates.map((date) =>
    [...byProvider.values()].flatMap((caps) => {
      const at = caps.filter((c) => dayOf(c.captured_at) <= date).at(-1)
      return at && dayOf(at.captured_at) >= addDays(date, -GPU_ARCHIVE_STALE_DAYS)
        ? at.observations
        : []
    }),
  )
  return {
    dates,
    gpus: GPU_MODELS.map((gpu) => {
      const medians = reads.map((obs) => gpuMedian(gpu, obs))
      return {
        gpu,
        median: medians.map((m) => m.median),
        providers: medians.map((m) => Object.keys(m.providers).length),
      }
    }),
  }
}

/** The archived GPU history, or null before the backfill has stored anything. */
export async function queryGpuArchive(db: PipelineDb): Promise<GpuArchiveView | null> {
  const [rows, skipped] = await Promise.all([
    db
      .select({
        capture_id: tables.archivedGpuPrices.capture_id,
        provider: tables.archivedGpuPrices.provider,
        value: tables.archivedGpuPrices.value,
        payload: tables.archivedGpuPrices.payload,
        captured_at: tables.archivedGpuPrices.captured_at,
        source_url: tables.archivedGpuPrices.source_url,
        fetched_at: tables.archivedGpuPrices.fetched_at,
      })
      .from(tables.archivedGpuPrices)
      .orderBy(asc(tables.archivedGpuPrices.captured_at)),
    db
      .select({ provider: tables.archiveCaptures.provider, status: tables.archiveCaptures.status })
      .from(tables.archiveCaptures)
      .where(eq(tables.archiveCaptures.axis, 'gpu')),
  ])
  if (rows.length === 0) return null

  const captures = new Map<string, ArchivedGpuCapture>()
  for (const r of rows) {
    const p = gpuPricePayload.parse(JSON.parse(r.payload))
    const held = captures.get(r.capture_id) ?? {
      provider: r.provider,
      capture_id: r.capture_id,
      captured_at: r.captured_at,
      source_url: r.source_url,
      fetched_at: r.fetched_at,
      observations: [],
    }
    held.observations.push({
      provider: r.provider,
      gpu: p.gpu,
      counted: p.counted,
      value: r.value,
      source_url: r.source_url,
      fetched_at: r.fetched_at,
    })
    captures.set(r.capture_id, held)
  }
  const liveFrom = dayOf(GPU_ARCHIVE_UNTIL)
  const all = [...captures.values()]
  const providers = [...new Set(all.map((c) => c.provider))].sort(byString)
  return {
    ...archivedGpuSeries(all, liveFrom),
    providers: providers.map((provider) => ({
      provider,
      provider_name: gpuProviderName(provider),
      points: all
        .filter((c) => c.provider === provider)
        .map((c): ArchivedGpuPoint => {
          const value = (gpu: 'H100' | 'B200') =>
            gpuMedian(gpu, c.observations).providers[provider]?.value ?? null
          return {
            at: c.captured_at,
            basis: 'archived',
            source_id: archiveSourceId(c.capture_id),
            h100: value('H100'),
            b200: value('B200'),
            source_url: c.source_url,
            fetched_at: c.fetched_at,
          }
        }),
      skipped: skipped.filter((s) => s.provider === provider && s.status === 'skipped').length,
    })),
    gaps: GPU_ARCHIVE_GAPS.map((g) => ({ ...g, provider_name: gpuProviderName(g.provider) })),
    not_covered: GPU_ARCHIVE_NOT_COVERED.map((n) => ({
      ...n,
      provider_name: gpuProviderName(n.provider),
    })),
    live_from: liveFrom,
    method: GPU_ARCHIVE_METHOD,
  }
}
