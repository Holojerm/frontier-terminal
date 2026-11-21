// An archived price-list or rate-limit page capture -> its rows: archived_prices, one per
// SKU the page priced, and archived_rate_limits. Pure; scripts/wayback-backfill.ts fetches
// and writes (the capture row and its checks: layers/core/server/pipeline/archive/captures.ts).

import type * as tables from '#server/db/schema'
import { contentHash } from '../../../../core/server/pipeline/contracts'
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
import { normalizePrices } from '../normalize'
import type { ArchiveEra } from './eras'
import type { LimitsEra } from './limits-eras'

type ArchivedPriceRow = typeof tables.archivedPrices.$inferInsert
type ArchivedRateLimitRow = typeof tables.archivedRateLimits.$inferInsert

/**
 * Parse one capture's text with its era's parser. A throw is a skip whose
 * detail is the parser's own message: the page did not match the shape the
 * era expects, so nothing on it is stored as a price.
 */
export function archiveRows(
  era: ArchiveEra,
  capture: CdxCapture,
  text: string,
  bytes: number,
  fetchedAt: string,
): { capture: ArchiveCaptureRow; prices: ArchivedPriceRow[] } {
  const id = captureId(era, capture.timestamp)
  const source_url = captureUrl(capture.timestamp, capture.original)
  const captured_at = captureInstant(capture.timestamp)
  const stored = storedOf(era, capture, text, bytes)
  let entities
  let passed: string[] = []
  try {
    assertWhole(era, text)
    const parsed = era.parse(text, { source_url, fetched_at: fetchedAt })
    passed = parsed.passed ?? []
    entities = normalizePrices(parsed.rows, id)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { capture: skippedCapture(era, capture, fetchedAt, message, stored), prices: [] }
  }
  const prices: ArchivedPriceRow[] = entities.map((e) => ({
    id: contentHash({ capture: id, key: e.entity_key }).slice(0, 32),
    capture_id: id,
    entity_key: e.entity_key,
    provider: e.provider,
    content_hash: e.content_hash,
    payload: e.payload,
    captured_at,
    original_url: capture.original,
    basis: ARCHIVED_BASIS,
    source_url,
    fetched_at: fetchedAt,
  }))
  return {
    capture: {
      ...skippedCapture(era, capture, fetchedAt, '', stored),
      status: 'parsed',
      detail: passed.length ? `not read: ${passed.join(', ')}`.slice(0, 500) : null,
      rows: prices.length,
    },
    prices,
  }
}

/**
 * One rate-limit page capture -> its archived_rate_limits rows, keyed as the
 * live recipe keys its own. A throw is a skip with the parser's reason; what
 * the copy printed that couldn't be tied to a tier is named in the detail.
 */
export function limitsRows(
  era: LimitsEra,
  capture: CdxCapture,
  text: string,
  bytes: number,
  fetchedAt: string,
): { capture: ArchiveCaptureRow; limits: ArchivedRateLimitRow[] } {
  const id = captureId(era, capture.timestamp)
  const captured_at = captureInstant(capture.timestamp)
  const stored = storedOf(era, capture, text, bytes)
  let read
  try {
    assertWhole(era, text)
    read = era.parse(text)
    if (read.rows.length === 0) throw new Error('no limits on the copy')
    // A copy can render one table twice; the same limit at two values is a copy we can't read.
    const seen = new Map<string, number | null>()
    const once: typeof read.rows = []
    for (const r of read.rows) {
      if (!seen.has(r.key)) {
        seen.set(r.key, r.value)
        once.push(r)
      } else if (seen.get(r.key) !== r.value) {
        throw new Error(`the copy prints ${r.key} at two values`)
      }
    }
    read = { ...read, rows: once }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      capture: skippedCapture(era, capture, fetchedAt, message, stored, 'limits'),
      limits: [],
    }
  }
  const source_url = captureUrl(capture.timestamp, capture.original)
  const limits: ArchivedRateLimitRow[] = read.rows.map((r) => ({
    id: contentHash({ capture: id, key: r.key }).slice(0, 32),
    capture_id: id,
    provider: era.provider,
    recipe_id: era.recipe_id,
    key: r.key,
    model: r.model,
    tier: r.tier,
    metric: r.metric,
    value: r.value,
    payload: JSON.stringify({ model: r.model, tier: r.tier, metric: r.metric, printed: r.printed }),
    captured_at,
    original_url: capture.original,
    basis: ARCHIVED_BASIS,
    source_url,
    fetched_at: fetchedAt,
  }))
  return {
    capture: {
      ...skippedCapture(era, capture, fetchedAt, '', stored, 'limits'),
      status: 'parsed',
      detail: read.passed.length ? `not read: ${read.passed.join('; ')}`.slice(0, 500) : null,
      rows: limits.length,
    },
    limits,
  }
}
