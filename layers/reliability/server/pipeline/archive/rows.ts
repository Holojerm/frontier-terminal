// An archived status-feed capture -> its archived_incidents rows. Pure;
// scripts/wayback-backfill.ts fetches and writes (the capture row and its checks:
// layers/core/server/pipeline/archive/captures.ts).

import type * as tables from '#server/db/schema'
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
import type { StatusEra } from './status-eras'

type ArchivedIncidentInsert = typeof tables.archivedIncidents.$inferInsert

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
