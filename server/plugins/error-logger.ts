// Structured error logging for unhandled API errors.
//
// Two destinations:
//   1. console.error JSON → Cloudflare Logs (cheap, queryable, always on)
//   2. the `ops_events` spool → server/tasks/ops/alert.ts emails a digest on
//      a cron. This is the one that reaches someone who isn't looking at a
//      dashboard, which is the whole point. Awaited, because Workers cancels
//      in-flight promises once the response is sent and a 5xx is exactly the
//      path that sends one immediately.
//
// 4xx are skipped — they're expected client mistakes (404 on a bad slug, 429
// from the rate limiter) and would drown out real bugs.

// Explicit, not the Nitro auto-import that every sibling also spells out. This
// file is the one that runs while a 500 is already in flight, so a symbol that
// resolves to `undefined` at runtime — the failure .claude/docs/gotchas.md
// documents — would throw inside the error handler and take the log line with
// the exception it was trying to record.
import { db } from '@nuxthub/db'

import { pathForLog } from '../utils/log'
import { recordOpsEvent } from '../utils/ops'

export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('error', async (error, { event }) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500
    if (status < 500) return

    const err = error as Error
    console.error(
      JSON.stringify({
        kind: 'server_error',
        status,
        message: err.message,
        stack: err.stack,
        // Never event.path verbatim — see server/utils/log.ts.
        path: pathForLog(event?.path),
        method: event?.method,
      }),
    )

    await recordOpsEvent(db, {
      kind: 'server_error',
      detail: `${status} ${err.message}`,
      path: pathForLog(event?.path),
    })
  })
})
