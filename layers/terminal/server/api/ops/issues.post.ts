// POST /api/ops/issues — where the Workers Issues automation (Cloudflare
// dashboard › frontier-terminal › Issues › Automations, a generic webhook)
// reports each new or returning issue. Each becomes an ops event, so it lands
// in the same digest email as every other alert, and at once, because
// `workers_issue` is critical (layers/terminal/server/utils/ops-immediate.ts).
//
// Cloudflare authenticates the call by sending the destination's secret in
// `cf-webhook-auth`. Same verdicts as the other bearer routes: 404 when the
// secret is unset, 401 when the header is missing or wrong. The payload is
// Cloudflare's standard Notifications webhook schema; only `text` and
// `alert_event` are read, and the rest may grow without breaking this.

import { db } from '@nuxthub/db'
import { z } from 'zod'

import { verifyFleetToken } from '#server/utils/fleet-auth'
import { recordOpsEvent } from '#server/utils/ops'

const Payload = z
  .object({
    name: z.string().max(500),
    text: z.string().max(5000),
    alert_type: z.string().max(200),
    alert_event: z.string().max(100),
  })
  .partial()
  .passthrough()

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'ops-issues', limit: 30, windowSeconds: 60 })
  const presented = getRequestHeader(event, 'cf-webhook-auth') ?? ''
  const verdict = await verifyFleetToken(`Bearer ${presented}`, {
    current: useRuntimeConfig(event).issuesWebhookSecret,
  })
  if (verdict === 'unconfigured') throw createError({ statusCode: 404 })
  if (verdict === 'unauthorized') throw createError({ statusCode: 401 })

  const body = await readValidatedBody(event, Payload.parse)
  const resolved = body.alert_event === 'ALERT_STATE_EVENT_END'
  await recordOpsEvent(db, {
    kind: resolved ? 'workers_issue_resolved' : 'workers_issue',
    detail: (body.text || body.name || 'Workers Issues reported an issue').slice(0, 500),
  })
  return { ok: true }
})
