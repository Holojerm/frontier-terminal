// What every terminal API response carries around its payload, beyond the
// license split (shared/utils/license.ts › withLicense): the schema version,
// and for a licensee's key the license that key holds on older data. Pure, so
// layers/terminal/test/api-keys.test.ts drives it without Nitro.

import { HISTORY_LICENSE, PAID_LICENSE, licenseSplit } from '#shared/utils/license'

import { SCHEMA_VERSION } from './data-schema'

/**
 * The payload with `schema_version` first (data-schema.ts). Added after the
 * cache, so a release never waits on a cached entry to roll over. An array or
 * null passes through.
 */
export function withSchemaVersion<T>(payload: T): T {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload
  return { schema_version: SCHEMA_VERSION, ...payload }
}

// How an Internet Archive row shows in a payload: a history point's basis, or
// an as_of catalog row's source_id (terminal-history.ts › archiveSourceId).
const ARCHIVED_MARKERS = ['"basis":"archived"', '"source_id":"wayback:']

/** Whether any row in `payload` was read from the Internet Archive. */
export function carriesArchived(payload: object): boolean {
  const json = JSON.stringify(payload)
  return ARCHIVED_MARKERS.some((marker) => json.includes(marker))
}

/**
 * `payload` relabeled for a licensee: its `license` field, and an as_of label
 * of CC BY-NC. A payload carrying Internet Archive rows keeps its public
 * labels: the Archive grants access for scholarship and research
 * (sources.yaml › wayback-pricing, rights not-cleared), so a key can't license
 * them, the same rule as ARCHIVED_EXPORTS.
 */
export function paidLicensed<T extends object>(payload: T, now: Date = new Date()): T {
  if (carriesArchived(payload)) return payload
  const out = { ...payload } as Record<string, unknown>
  if ('license' in out) out.license = licenseSplit(now, PAID_LICENSE)
  const pit = out.point_in_time
  if (pit && typeof pit === 'object' && 'license' in pit && pit.license === HISTORY_LICENSE.id) {
    out.point_in_time = { ...pit, license: PAID_LICENSE.id }
  }
  return out as T
}
