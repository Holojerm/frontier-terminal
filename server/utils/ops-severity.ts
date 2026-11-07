// How loud each ops event kind is, for the digest (server/tasks/ops/alert.ts).
//
// The tiers are about what the owner has to do, not how alarming the word in
// the kind sounds:
//
// - critical — the app has stopped doing its job: requests failing wholesale,
//   payments being dropped, the thing it exists for not happening. The digest
//   subject leads with [Critical]; a mail filter on it makes the phone buzz.
// - warning — one part is degraded. Worth a look today. Also the tier of every
//   kind nobody registered: a new failure path is seen before anyone decides
//   it can be quiet.
// - info — the system handled it, or it is a known setup state.
//
// The tier also sets how long a row waits before it is mailed (OPS_HOLD_MS in
// server/utils/ops.ts): critical on the next drain, warning after 25 minutes,
// info after a day, quieter rows riding along with the first louder digest.
//
// Core knows one kind, `server_error`, and escalates it on a burst. A feature
// layer or a fork registers its own kinds from a Nitro plugin, next to the
// `recordOpsEvent` calls that spool them (layers/billing does this in
// billing-extensions.ts). A plain registry rather than Nitro hooks for the reason
// server/utils/extensions.ts gives: tests drive the drain without booting Nitro.

import type { OpsClassifier, OpsKindPolicy } from './ops-digest'

/**
 * This many unmailed 5xxs at one drain means the app is broken, not one route:
 * the kind turns critical and is mailed on that drain instead of waiting out
 * a warning's hold.
 */
export const SERVER_ERROR_CRITICAL_COUNT = 10

const SERVER_ERROR_BURST: OpsKindPolicy = {
  severity: 'critical',
  action:
    'Many requests are failing at once. Open the logs; check /api/status for pending migrations.',
}

const policies = new Map<string, OpsKindPolicy>()

/**
 * Give kinds a tier and, for the loud ones, a one-line "what to do". Later
 * registrations of the same kind win, so a fork can re-tier a layer's kind.
 */
export function registerOpsSeverity(table: Record<string, OpsKindPolicy>): void {
  for (const [kind, policy] of Object.entries(table)) policies.set(kind, policy)
}

/** Test-only. */
export function resetOpsSeverityForTest(): void {
  policies.clear()
}

/** The classifier the digest cron passes to drainOpsEvents(). */
export const classifyOps: OpsClassifier = (kind, count) => {
  const registered = policies.get(kind)
  if (registered) return registered
  if (kind === 'server_error') {
    return count >= SERVER_ERROR_CRITICAL_COUNT ? SERVER_ERROR_BURST : { severity: 'warning' }
  }
  return { severity: 'warning' }
}
