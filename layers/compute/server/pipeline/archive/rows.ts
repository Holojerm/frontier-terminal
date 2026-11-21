// An archived GPU rental price page capture -> its archived_gpu_prices rows. Pure;
// scripts/wayback-backfill.ts fetches and writes (the capture row and its checks:
// layers/core/server/pipeline/archive/captures.ts).

import type * as tables from '#server/db/schema'
import { contentHash } from '../../../../core/server/utils/contracts'
import {
  captureInstant,
  captureUrl,
  type CdxCapture,
} from '../../../../core/server/pipeline/archive/wayback'
import {
  ARCHIVED_BASIS,
  assertWhole,
  captureId,
  skippedCapture,
  storedOf,
  type ArchiveCaptureRow,
} from '../../../../core/server/pipeline/archive/captures'
import { gpuObservations } from '../../recipes/gpu-prices'
import type { GpuEra } from './gpu-eras'

type ArchivedGpuPriceRow = typeof tables.archivedGpuPrices.$inferInsert

/**
 * One capture -> its archived_gpu_prices rows, validated by the live contract
 * (gpu-prices.ts › gpuObservations). A throw is a skip with the reason.
 */
export function gpuRows(
  era: GpuEra,
  capture: CdxCapture,
  text: string,
  bytes: number,
  fetchedAt: string,
): { capture: ArchiveCaptureRow; prices: ArchivedGpuPriceRow[] } {
  const id = captureId(era, capture.timestamp)
  const captured_at = captureInstant(capture.timestamp)
  const stored = storedOf(era, capture, text, bytes)
  let observations
  try {
    assertWhole(era, text)
    observations = gpuObservations(
      era.provider,
      era.parse(text, captured_at),
      captured_at.slice(0, 10),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      capture: skippedCapture(era, capture, fetchedAt, message, stored, 'gpu'),
      prices: [],
    }
  }
  const source_url = captureUrl(capture.timestamp, capture.original)
  const prices: ArchivedGpuPriceRow[] = observations.map((o) => ({
    id: contentHash({ capture: id, key: o.key }).slice(0, 32),
    capture_id: id,
    provider: era.provider,
    key: o.key,
    gpu: String((o.payload as { gpu: string }).gpu),
    value: o.value!,
    payload: JSON.stringify(o.payload),
    captured_at,
    original_url: capture.original,
    basis: ARCHIVED_BASIS,
    source_url,
    fetched_at: fetchedAt,
  }))
  return {
    capture: {
      ...skippedCapture(era, capture, fetchedAt, '', stored, 'gpu'),
      status: 'parsed',
      detail: null,
      rows: prices.length,
    },
    prices,
  }
}
