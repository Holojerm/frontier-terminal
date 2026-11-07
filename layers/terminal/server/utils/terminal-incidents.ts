// Status-page incidents over the trailing windows.

import { eq } from 'drizzle-orm'
import type {
  LabId,
  IncidentProviderView,
  IncidentView,
  IncidentsData,
  SourceRef,
} from '../../shared/utils/terminal-types'

import * as tables from '#server/db/schema'
import type { PipelineDb } from '../pipeline/store'
import { byString, parseJson, str, type Json } from './terminal-json'
import { INCIDENT_SOURCES, PROVIDER_DISPLAY, PROVIDER_ORDER, labelOf } from './terminal-sources'
import { cutReason, sourceReads, stampOf, type QueryContext } from './terminal-db'

// ---- incidents (capacity strain) -------------------------------------------

export const INCIDENT_WINDOW_DAYS = 30
export const INCIDENT_HISTORY_DAYS = 90

const DAY_MS = 86_400_000

function incidentFromPayload(
  base: {
    entity_key: string
    source_id: string
    provider: string
    source_url: string
    fetched_at: string
  },
  payload: Json,
): IncidentView | null {
  const incident_id = str(payload.incident_id)
  const title = str(payload.title)
  const started_at = str(payload.started_at)
  const incident_url = str(payload.incident_url)
  if (!incident_id || !title || !started_at || !incident_url) return null
  const components = Array.isArray(payload.components)
    ? payload.components.filter((c): c is string => typeof c === 'string')
    : []
  return {
    entity_key: base.entity_key,
    source_id: base.source_id,
    provider: base.provider as LabId,
    incident_id,
    title,
    impact: str(payload.impact),
    status: str(payload.status) ?? '?',
    started_at,
    resolved_at: str(payload.resolved_at),
    components,
    incident_url,
    source_url: base.source_url,
    fetched_at: base.fetched_at,
  }
}

/** Newest started_at first; id breaks ties so the order is total. */
const newestFirst = (a: IncidentView, b: IncidentView) =>
  a.started_at === b.started_at
    ? byString(a.entity_key, b.entity_key)
    : a.started_at < b.started_at
      ? 1
      : -1

/**
 * Incident counts are windows over `started_at` as the vendor posted it,
 * anchored to each lab's own feed — its last successful read — rather than
 * the reader's clock, the same reason the signal band anchors to the newest
 * detection. One anchor for every lab let a feed that stopped reading count
 * a window it never saw as quiet. Each provider ships its anchor
 * (window_to) so the claim is checkable, and reports where its held history
 * begins: a Statuspage feed is a rolling window, so the prior-30-day count
 * is partial until the pipeline has polled through it, and the UI says so
 * rather than printing a low number.
 */
export async function queryIncidents(db: PipelineDb, ctx: QueryContext): Promise<IncidentsData> {
  const [entities, stamps] = await Promise.all([
    db.select().from(tables.entities).where(eq(tables.entities.entity_type, 'incident')),
    sourceReads(db).then((r) => r.cited),
  ])

  const anchors = Object.values(INCIDENT_SOURCES)
    .flatMap((b) => ('source_id' in b ? [stamps.get(b.source_id)?.fetched_at] : []))
    .filter((at): at is string => at !== undefined)
    .sort(byString)
  // The list and a feed with no read yet count back from the freshest anchor.
  const windowTo = anchors.at(-1) ?? ctx.now().toISOString()
  const historyFrom = Date.parse(windowTo) - INCIDENT_HISTORY_DAYS * DAY_MS

  const all: IncidentView[] = []
  for (const e of entities) {
    const payload = parseJson(e.payload)
    const view = payload && incidentFromPayload(e, payload)
    if (view) all.push(view)
  }
  all.sort(newestFirst)

  const providers: IncidentProviderView[] = []
  for (const provider of PROVIDER_ORDER) {
    const backing = INCIDENT_SOURCES[provider]
    if ('cut_id' in backing) {
      // Honest cut — never a fabricated zero (sources.yaml `cut.<lab>-status`).
      providers.push({
        provider,
        display: PROVIDER_DISPLAY[provider],
        feed: 'no_public_feed',
        reason:
          cutReason(ctx, backing.cut_id) ??
          `No public status feed is reachable for ${PROVIDER_DISPLAY[provider]}.`,
        caveat: null,
        window_to: null,
        last_window: 0,
        prior_window: 0,
        open: [],
        coverage_from: null,
        sources: [],
      })
      continue
    }
    const sourceId = backing.source_id
    const rows = all.filter((i) => i.provider === provider)
    const startedMs = (i: IncidentView) => Date.parse(i.started_at)
    const stamp = stamps.get(sourceId)
    const ownTo = stamp?.fetched_at ?? windowTo
    const toMs = Date.parse(ownTo)
    const lastFrom = toMs - INCIDENT_WINDOW_DAYS * DAY_MS
    const priorFrom = toMs - 2 * INCIDENT_WINDOW_DAYS * DAY_MS
    const sources: SourceRef[] = stamp
      ? [{ source_id: sourceId, label: labelOf(sourceId).label, ...stamp }]
      : []
    providers.push({
      provider,
      display: PROVIDER_DISPLAY[provider],
      feed: rows.length > 0 ? 'ok' : 'no_rows',
      reason: null,
      caveat: ctx.registry.sources.find((s) => s.source_id === sourceId)?.caveat ?? null,
      window_to: ownTo,
      last_window: rows.filter((i) => startedMs(i) > lastFrom && startedMs(i) <= toMs).length,
      prior_window: rows.filter((i) => startedMs(i) > priorFrom && startedMs(i) <= lastFrom).length,
      open: rows.filter((i) => i.resolved_at === null),
      coverage_from: rows.map((i) => i.started_at).sort(byString)[0] ?? null,
      sources,
    })
  }

  return {
    ...stampOf(ctx),
    window_to: windowTo,
    window_days: INCIDENT_WINDOW_DAYS,
    history_days: INCIDENT_HISTORY_DAYS,
    providers,
    incidents: all.filter((i) => Date.parse(i.started_at) > historyFrom),
  }
}
