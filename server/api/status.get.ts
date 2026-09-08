// GET /api/status — what a dashboard needs to know about this deployment, in
// one public, unauthenticated, no-secrets payload.
//
// /api/health stays as it is (liveness only) and this sits beside it, because
// the two answer different questions. Health says "is the Worker up and can it
// reach D1". Status says "is what is running the thing that was meant to be
// running": which commit, which migrations production has actually applied
// against which the code expects, which crons Nitro will answer. Those are
// the questions an uptime check cannot ask and the portfolio dashboard
// (`fleet`) polls every fifteen minutes.
//
// Public on purpose. Nothing here is a secret — migration tags, a commit sha,
// cron expressions and the app's own name are all in the public repo of an
// open-source fork and in the bundle of a closed one — and the one reader that
// most needs it, an external heartbeat, must not have to hold a credential.
// Anything that IS operational detail lives behind a bearer in /api/fleet instead.
//
// The payload and its HTTP code are decided by collectStatus() in
// server/utils/fleet-status.ts, which the MCP `get_status` tool shares.

import { db } from '@nuxthub/db'

import { collectStatus } from '../utils/fleet-status'

export default defineEventHandler(async (event) => {
  // Same budget as /api/health: generous for a monitor, useless as a load generator.
  await rateLimit(event, { name: 'status', limit: 60, windowSeconds: 60 })
  setResponseHeader(event, 'Cache-Control', 'no-store')

  const config = useRuntimeConfig(event)
  const { httpStatus, payload } = await collectStatus(db, {
    buildSha: config.public.buildSha,
    buildDate: config.buildDate,
    scheduledTasks: config.scheduledTasks,
  })
  setResponseStatus(event, httpStatus)
  return payload
})
