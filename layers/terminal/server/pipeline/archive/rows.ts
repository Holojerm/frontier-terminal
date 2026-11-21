// One archived capture -> the rows the backfill writes: an archive_captures
// row (parsed, or skipped with the reason) and the rows it yields, one
// archived_prices row per SKU a pricing page priced, or the archived_hiring
// counts a job board listed, the archived_gpu_prices rows a GPU rental
// price page priced, or the archived_incidents a status feed listed. Pure: the bytes, the capture and the fetch time
// in, rows out. scripts/wayback-backfill.ts does the fetching and the writing.

import type * as tables from '#server/db/schema'
import { contentHash, contentHashOfText } from '#layers/core/server/pipeline/contracts'
import { normalizePrices } from '../normalize'
import { gpuObservations } from '#layers/compute/server/recipes/gpu-prices'
import type { ArchiveEra } from './eras'
import type { GpuEra } from '#layers/compute/server/pipeline/archive/gpu-eras'
import type { LimitsEra } from './limits-eras'
import { liveDepartment, type HiringEra } from './hiring-eras'
import type { StatusEra } from './status-eras'
import { captureInstant, captureUrl, type CdxCapture } from './wayback'
import type { ArchiveAxis } from '#layers/core/server/utils/archive-floor'

export type ArchiveCaptureRow = typeof tables.archiveCaptures.$inferInsert
export type ArchivedPriceRow = typeof tables.archivedPrices.$inferInsert
export type ArchivedHiringRow = typeof tables.archivedHiring.$inferInsert
export type ArchivedGpuPriceRow = typeof tables.archivedGpuPrices.$inferInsert
export type ArchivedIncidentInsert = typeof tables.archivedIncidents.$inferInsert
export type ArchivedRateLimitRow = typeof tables.archivedRateLimits.$inferInsert

export const ARCHIVED_BASIS = 'archived'

/** The lab axes, whose archived rows answer an as_of before the live record (terminal-archive.ts). */
export type { ArchiveAxis }

/**
 * Every axis a capture's rows can go to; gpu (archived_gpu_prices) is per
 * provider, not per lab, and status (archived_incidents) is one row per
 * incident across copies, not per copy.
 */
export type CaptureAxis = ArchiveAxis | 'gpu' | 'status' | 'limits'

/** What a capture row needs of its era, on any axis; a GPU or status era may name its format and end. */
type EraRef = Pick<
  ArchiveEra | HiringEra | GpuEra | StatusEra | LimitsEra,
  'id' | 'provider' | 'url'
> & {
  ext?: GpuEra['ext'] | StatusEra['ext'] | LimitsEra['ext']
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
function assertWhole(era: EraRef, text: string) {
  const end = era.end ?? /<\/html>/i
  if ((era.end || extensionOf(era) === 'html') && !end.test(text.slice(-4096))) {
    throw new Error(`capture is truncated: no closing ${end.source.replace(/\\/g, '')}`)
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

/**
 * One GPU price page capture -> its archived_gpu_prices rows, validated by
 * the live recipes' contract (gpu-prices.ts › gpuObservations): the same
 * keys, the same payload, and the same refusal of a page that prices one
 * key twice or names no H100 or B200 on-demand price. A throw is a skip with
 * the reason.
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

/**
 * One status feed capture -> its incidents, in the live IncidentRow shape,
 * each as an archived_incidents row naming this copy. The script upserts
 * them: a newer copy's state replaces an older one's, and first_captured_at
 * keeps the oldest copy that listed the incident. The capture row records how
 * far back the copy reaches (covers_from). A throw is a skip with the reason.
 */
export function statusRows(
  era: StatusEra,
  capture: CdxCapture,
  text: string,
  bytes: number,
  fetchedAt: string,
): { capture: ArchiveCaptureRow; incidents: ArchivedIncidentInsert[] } {
  const id = captureId(era, capture.timestamp)
  const captured_at = captureInstant(capture.timestamp)
  const source_url = captureUrl(capture.timestamp, capture.original)
  const stored = storedOf(era, capture, text, bytes)
  let read
  try {
    assertWhole(era, text)
    read = era.parse(text, { source_url, fetched_at: fetchedAt })
    const stray = read.rows.find((r) => r.provider !== era.provider)
    if (stray) throw new Error(`a row for ${stray.provider} in a ${era.provider} feed`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      capture: skippedCapture(era, capture, fetchedAt, message, stored, 'status'),
      incidents: [],
    }
  }
  const incidents: ArchivedIncidentInsert[] = read.rows.map((r) => ({
    id: `${r.provider}:${r.incident_id}`,
    provider: r.provider,
    incident_id: r.incident_id,
    title: r.title,
    impact: r.impact,
    status: r.status,
    started_at: r.started_at,
    resolved_at: r.resolved_at,
    components: JSON.stringify(r.components),
    incident_url: r.incident_url,
    capture_id: id,
    captured_at,
    first_captured_at: captured_at,
    original_url: capture.original,
    basis: ARCHIVED_BASIS,
    source_url,
    fetched_at: fetchedAt,
  }))
  return {
    capture: {
      ...skippedCapture(era, capture, fetchedAt, '', stored, 'status'),
      status: 'parsed',
      detail: read.note?.slice(0, 500) ?? null,
      rows: incidents.length,
      covers_from: read.covers_from,
    },
    incidents,
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
