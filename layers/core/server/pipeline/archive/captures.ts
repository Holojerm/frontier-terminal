// One archived capture's own row: the archive_captures row every axis writes (parsed, or
// skipped with the reason), the R2 key its bytes go under, and the checks every axis applies
// before its parser runs. Each axis turns a capture into its rows in its own layer (the
// pricing, talent, compute and reliability layers' server/pipeline/archive/rows.ts). Pure:
// the bytes, the capture and the fetch time in, rows out. scripts/wayback-backfill.ts does the
// fetching and the writing.

import type * as tables from '#server/db/schema'
import { contentHashOfText } from '../../utils/contracts'
import { captureInstant, captureUrl, type CdxCapture } from './wayback'
import type { ArchiveAxis } from '../../utils/archive-floor'

export type ArchiveCaptureRow = typeof tables.archiveCaptures.$inferInsert

export const ARCHIVED_BASIS = 'archived'

/** The lab axes, whose archived rows answer an as_of before the live record (each axis's terminal-*-archive.ts). */
export type { ArchiveAxis }

/**
 * Every axis a capture's rows can go to; gpu (archived_gpu_prices) is per
 * provider, not per lab, and status (archived_incidents) is one row per
 * incident across copies, not per copy.
 */
export type CaptureAxis = ArchiveAxis | 'gpu' | 'status' | 'limits'

/** What a capture row needs of its era, on any axis; a GPU or status era may name its format and end. */
export interface EraRef {
  id: string
  provider: string
  url: string
  ext?: string
  end?: RegExp
}

export const captureId = (era: Pick<EraRef, 'id'>, timestamp: string) => `${era.id}:${timestamp}`

const extensionOf = ({ url, ext }: EraRef) =>
  ext ??
  (url.endsWith('.md') ? 'md' : /\/\/(boards-)?api\.|\/v1\/boards\//.test(url) ? 'json' : 'html')

/** Where the capture's bytes are kept in R2: beside the live raw/ prefix, never inside it. */
export function archiveRawKey(era: EraRef, timestamp: string): string {
  return `archive/wayback/${era.id}/${timestamp}.${extensionOf(era)}`
}

/** A capture that yielded no rows, and why. */
export function skippedCapture(
  era: EraRef,
  capture: CdxCapture,
  fetchedAt: string,
  detail: string,
  stored: { content_hash: string; raw_key: string; bytes: number } | null = null,
  axis: CaptureAxis = 'pricing',
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
 * roles closed, a truncated feed as fewer incidents, so an HTML capture with
 * no closing </html>, or one without the end its era names, is skipped. A cut
 * JSON or markdown body fails its own parse.
 */
export function assertWhole(era: EraRef, text: string) {
  const end = era.end ?? /<\/html>/i
  if ((era.end || extensionOf(era) === 'html') && !end.test(text.slice(-4096))) {
    throw new Error(`capture is truncated: no closing ${end.source.replace(/\\/g, '')}`)
  }
}

/** What the capture row records of the bytes: their hash, R2 key and size. */
export function storedOf(era: EraRef, capture: CdxCapture, text: string, bytes: number) {
  return {
    content_hash: contentHashOfText(text),
    raw_key: archiveRawKey(era, capture.timestamp),
    bytes,
  }
}
