// Every lane the refresh runs: how each include source's fetched body becomes
// entities, and what is redacted from a fetched body before it is stored. The
// app's composition root for lanes; each domain defines its lanes beside its
// parsers and adds them here. Read-path code that only asks whether a source
// is a 'set' lane reads set-lanes.ts instead, which imports no parser.

import type { Lane, PayloadRedaction } from '#layers/core/server/pipeline/lanes'
import { PRICE_DERIVED_LANES, PRICE_LANES } from '#layers/pricing/server/pipeline/lanes'
import { TALENT_LANES } from '#layers/talent/server/pipeline/lanes'
import { GREENHOUSE_REDACTION } from '#layers/talent/server/pipeline/redact'
import {
  DERIVED_LANES as TERMINAL_DERIVED_LANES,
  LANES as TERMINAL_LANES,
} from '#layers/terminal/server/pipeline/lanes'

export const LANES: Readonly<Record<string, Lane>> = {
  ...PRICE_LANES,
  ...TALENT_LANES,
  ...TERMINAL_LANES,
}

export const DERIVED_LANES: readonly { prefix: string; lane: Lane }[] = [
  ...TERMINAL_DERIVED_LANES,
  ...PRICE_DERIVED_LANES,
]

/** Applied in order to every fetched body, sides included (core's redactPayload). */
export const PAYLOAD_REDACTIONS: readonly PayloadRedaction[] = [GREENHOUSE_REDACTION]

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
