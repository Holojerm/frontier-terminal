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

/** `payload` relabeled for a licensee: its `license` field, and an as_of label of CC BY-NC. */
export function paidLicensed<T extends object>(payload: T, now: Date = new Date()): T {
  const out = { ...payload } as Record<string, unknown>
  if ('license' in out) out.license = licenseSplit(now, PAID_LICENSE)
  const pit = out.point_in_time
  if (pit && typeof pit === 'object' && 'license' in pit && pit.license === HISTORY_LICENSE.id) {
    out.point_in_time = { ...pit, license: PAID_LICENSE.id }
  }
  return out as T
}
