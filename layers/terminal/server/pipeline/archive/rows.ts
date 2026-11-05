// One archived capture -> the rows the backfill writes: an archive_captures
// row (parsed, or skipped with the reason) and the rows it yields, one
// archived_prices row per SKU a pricing page priced, or the archived_hiring
// counts a job board listed. Pure: the bytes, the capture and the fetch time
// in, rows out. scripts/wayback-backfill.ts does the fetching and the writing.

import type * as tables from '#server/db/schema'
import { contentHash, contentHashOfText } from '../contracts'
import { normalizePrices } from '../normalize'
import type { ArchiveEra } from './eras'
import { liveDepartment, type HiringEra } from './hiring-eras'
import { captureInstant, captureUrl, type CdxCapture } from './wayback'

export type ArchiveCaptureRow = typeof tables.archiveCaptures.$inferInsert
export type ArchivedPriceRow = typeof tables.archivedPrices.$inferInsert
export type ArchivedHiringRow = typeof tables.archivedHiring.$inferInsert

export const ARCHIVED_BASIS = 'archived'

export type ArchiveAxis = 'pricing' | 'hiring'

/** What a capture row needs of its era, pricing or hiring. */
type EraRef = Pick<ArchiveEra | HiringEra, 'id' | 'provider' | 'url'>

export const captureId = (era: Pick<EraRef, 'id'>, timestamp: string) => `${era.id}:${timestamp}`

const extensionOf = (url: string) =>
  url.endsWith('.md') ? 'md' : /\/\/(boards-)?api\.|\/v1\/boards\//.test(url) ? 'json' : 'html'

/** Where the capture's bytes are kept in R2: beside the live raw/ prefix, never inside it. */
export function archiveRawKey(era: EraRef, timestamp: string): string {
  return `archive/wayback/${era.id}/${timestamp}.${extensionOf(era.url)}`
}

/** A capture that yielded no rows, and why. */
export function skippedCapture(
  era: EraRef,
  capture: CdxCapture,
  fetchedAt: string,
  detail: string,
  stored: { content_hash: string; raw_key: string; bytes: number } | null = null,
  axis: ArchiveAxis = 'pricing',
): ArchiveCaptureRow {
  return {
    id: captureId(era, capture.timestamp),
    era: era.id,
    provider: era.provider,
    original_url: capture.original,
    captured_at: captureInstant(capture.timestamp),
    status: 'skipped',
    axis,
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
 * The Archive keeps some captures cut short (a 1 MiB body with no end). A
 * truncated price list would read as SKUs delisted, a truncated board as
 * roles closed, so an HTML capture with no closing </html> is skipped. A cut
 * JSON or markdown body fails its own parse.
 */
function assertWhole(era: EraRef, text: string) {
  if (extensionOf(era.url) === 'html' && !/<\/html>/i.test(text.slice(-4096))) {
    throw new Error('capture is truncated: no closing </html>')
  }
}

function storedOf(era: EraRef, capture: CdxCapture, text: string, bytes: number) {
  return {
    content_hash: contentHashOfText(text),
    raw_key: archiveRawKey(era, capture.timestamp),
    bytes,
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
 * One job-board capture -> its counts: a `board` row with the open roles
 * on the whole board and, when the capture lists every role with its
 * department, a `department` row per department. A throw is a skip with the
 * parser's reason; the department rows always sum to the board row.
 */
export function hiringRows(
  era: HiringEra,
  capture: CdxCapture,
  text: string,
  bytes: number,
  fetchedAt: string,
): { capture: ArchiveCaptureRow; counts: ArchivedHiringRow[] } {
  const id = captureId(era, capture.timestamp)
  const stored = storedOf(era, capture, text, bytes)
  let parsed
  try {
    assertWhole(era, text)
    parsed = era.parse(text)
    const sum = parsed.departments?.reduce((n, d) => n + d.open_roles, 0)
    if (sum !== undefined && sum !== parsed.total) {
      throw new Error(`departments sum to ${sum}, the board to ${parsed.total}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      capture: skippedCapture(era, capture, fetchedAt, message, stored, 'hiring'),
      counts: [],
    }
  }
  const base = {
    capture_id: id,
    provider: era.provider,
    captured_at: captureInstant(capture.timestamp),
    original_url: capture.original,
    basis: ARCHIVED_BASIS,
    source_url: captureUrl(capture.timestamp, capture.original),
    fetched_at: fetchedAt,
  }
  const counts: ArchivedHiringRow[] = [
    {
      ...base,
      id: contentHash({ capture: id, scope: 'board' }).slice(0, 32),
      scope: 'board',
      label: null,
      department_id: null,
      department: null,
      open_roles: parsed.total,
    },
    ...(parsed.departments ?? []).map((d) => ({
      ...base,
      id: contentHash({ capture: id, label: d.label, department_id: d.department_id }).slice(0, 32),
      scope: 'department',
      label: d.label,
      department_id: d.department_id,
      department: liveDepartment(era.provider, d.department_id, d.label),
      open_roles: d.open_roles,
    })),
  ]
  return {
    capture: {
      ...skippedCapture(era, capture, fetchedAt, '', stored, 'hiring'),
      status: 'parsed',
      detail: (parsed.note ?? (parsed.departments ? null : 'total only'))?.slice(0, 500) ?? null,
      rows: counts.length,
    },
    counts,
  }
}
