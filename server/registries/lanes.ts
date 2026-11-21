// Every lane the refresh runs: how each include source's fetched body becomes
// entities, what is redacted from a fetched body before it is stored, the
// alerts that read the store beyond a lane's changes, and the sources the
// store derives for itself. The app's composition root for lanes; each domain defines its lanes beside its
// parsers and adds them here. Read-path code that only asks whether a source
// is a 'set' lane reads set-lanes.ts instead, which imports no parser.

import type {
  ChangeAlertRule,
  Lane,
  PayloadRedaction,
  SourceDeriver,
} from '#layers/core/server/pipeline/lanes'
import type { FetchSource } from '#layers/core/server/pipeline/sources'
import type { PipelineDb } from '#layers/core/server/pipeline/store'
import { ADOPTION_LANES } from '#layers/adoption/server/pipeline/lanes'
import { MODEL_DERIVED_LANES, MODEL_LANES } from '#layers/models/server/pipeline/lanes'
import { modelFloorAlerts } from '#layers/models/server/pipeline/model-floor'
import { PRICE_DERIVED_LANES, PRICE_LANES } from '#layers/pricing/server/pipeline/lanes'
import { RELIABILITY_LANES } from '#layers/reliability/server/pipeline/lanes'
import { TALENT_LANES } from '#layers/talent/server/pipeline/lanes'
import { GREENHOUSE_REDACTION } from '#layers/talent/server/pipeline/redact'
import { deriveSources as deriveShellSources } from '#layers/terminal/server/pipeline/derived'
import { prospectusFloorAlerts } from '#layers/terminal/server/pipeline/prospectus-floor'
import {
  DERIVED_LANES as TERMINAL_DERIVED_LANES,
  LANES as TERMINAL_LANES,
} from '#layers/terminal/server/pipeline/lanes'

export const LANES: Readonly<Record<string, Lane>> = {
  ...PRICE_LANES,
  ...TALENT_LANES,
  ...RELIABILITY_LANES,
  ...TERMINAL_LANES,
  ...MODEL_LANES,
  ...ADOPTION_LANES,
}

export const DERIVED_LANES: readonly { prefix: string; lane: Lane }[] = [
  ...TERMINAL_DERIVED_LANES,
  ...MODEL_DERIVED_LANES,
  ...PRICE_DERIVED_LANES,
]

/** Applied in order to every fetched body, sides included (core's redactPayload). */
export const PAYLOAD_REDACTIONS: readonly PayloadRedaction[] = [GREENHOUSE_REDACTION]

/** Run in order after a lane's own alerts, on every source's changes (core's refresh.ts). */
export const CHANGE_ALERTS: readonly ChangeAlertRule[] = [
  modelFloorAlerts,
  (db, _sourceId, changes) => prospectusFloorAlerts(db, changes),
]

/** What derives sources from the store, in order (core's refresh and poll). */
export const DERIVED_SOURCES: readonly SourceDeriver[] = [deriveShellSources]

/** Every derived source the store can name right now, in a stable order. */
export async function deriveSources(db: PipelineDb, sourcesYaml: string): Promise<FetchSource[]> {
  const out: FetchSource[] = []
  for (const derive of DERIVED_SOURCES) out.push(...(await derive(db, sourcesYaml)))
  return out
}

/** The lane for a source id: a registered one exactly, a derived one by prefix. */
export function laneFor(sourceId: string): Lane | undefined {
  return LANES[sourceId] ?? DERIVED_LANES.find((d) => sourceId.startsWith(d.prefix))?.lane
}

/** The key a derived source id carries after its template prefix, or null. */
export function derivedKeyOf(sourceId: string): string | null {
  if (LANES[sourceId]) return null
  const d = DERIVED_LANES.find((x) => sourceId.startsWith(x.prefix))
  return d ? sourceId.slice(d.prefix.length) : null
}
