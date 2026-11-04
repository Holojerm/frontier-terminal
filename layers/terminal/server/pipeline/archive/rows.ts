// One archived capture -> the rows the backfill writes: an archive_captures
// row (parsed, or skipped with the reason) and one archived_prices row per
// SKU the page priced. Pure: the bytes, the capture and the fetch time in,
// rows out. scripts/wayback-backfill.ts does the fetching and the writing.

import type * as tables from '#server/db/schema'
import { contentHash, contentHashOfText } from '../contracts'
import { normalizePrices } from '../normalize'
import type { ArchiveEra } from './eras'
import { captureInstant, captureUrl, type CdxCapture } from './wayback'

export type ArchiveCaptureRow = typeof tables.archiveCaptures.$inferInsert
export type ArchivedPriceRow = typeof tables.archivedPrices.$inferInsert

export const ARCHIVED_BASIS = 'archived'

export const captureId = (era: ArchiveEra, timestamp: string) => `${era.id}:${timestamp}`

/** Where the capture's bytes are kept in R2: beside the live raw/ prefix, never inside it. */
export function archiveRawKey(era: ArchiveEra, timestamp: string): string {
  return `archive/wayback/${era.id}/${timestamp}.${era.url.endsWith('.md') ? 'md' : 'html'}`
}

/** A capture that yielded no rows, and why. */
export function skippedCapture(
  era: ArchiveEra,
  capture: CdxCapture,
  fetchedAt: string,
  detail: string,
  stored: { content_hash: string; raw_key: string; bytes: number } | null = null,
): ArchiveCaptureRow {
  return {
    id: captureId(era, capture.timestamp),
    era: era.id,
    provider: era.provider,
    original_url: capture.original,
    captured_at: captureInstant(capture.timestamp),
    status: 'skipped',
    detail: detail.slice(0, 500),
    content_hash: stored?.content_hash ?? null,
    raw_key: stored?.raw_key ?? null,
    bytes: stored?.bytes ?? null,
    rows: 0,
    source_url: captureUrl(capture.timestamp, capture.original),
    fetched_at: fetchedAt,
  }
}

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
  const stored = {
    content_hash: contentHashOfText(text),
    raw_key: archiveRawKey(era, capture.timestamp),
    bytes,
  }
  let entities
  let passed: string[] = []
  try {
    // The Archive keeps some captures cut short (a 1 MiB body with no end).
    // A truncated price list would read as SKUs delisted, so it is skipped.
    if (!era.url.endsWith('.md') && !/<\/html>/i.test(text.slice(-4096))) {
      throw new Error('capture is truncated: no closing </html>')
    }
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
      detail: passed.length
        ? `not read (priced per modality): ${passed.join(', ')}`.slice(0, 500)
        : null,
      rows: prices.length,
    },
    prices,
  }
}
