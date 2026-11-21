// An archived job-board capture -> its archived_hiring counts. Pure; scripts/wayback-backfill.ts
// fetches and writes (the capture row and its checks: layers/core/server/pipeline/archive/captures.ts).

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
import { liveDepartment, type HiringEra } from './hiring-eras'

type ArchivedHiringRow = typeof tables.archivedHiring.$inferInsert

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
