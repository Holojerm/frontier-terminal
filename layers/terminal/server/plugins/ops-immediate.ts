// Sends a critical ops event as soon as it is spooled
// (layers/terminal/server/utils/ops-immediate.ts says what counts and how it
// is throttled).
//
// recordOpsEvent() takes no event or task context, so the send_email binding
// is read from `globalThis.__env__`, which Nitro's cloudflare-module handler
// sets before every fetch, scheduled and queue invocation. Off Cloudflare it is
// absent, the mailer is null, and the next ops:alert tick still covers the row.

import { FleetManifestSchema } from '#shared/utils/fleet-manifest'
import { getOpsMailer } from '#server/utils/ops-mail'
import { onOpsEventRecorded } from '#server/utils/ops'
import { classifyOps } from '#server/utils/ops-severity'
import { logEvent } from '#server/utils/log'

import rawManifest from '../../../../fleet.json'
import { notifyIfCritical } from '../utils/ops-immediate'

const manifest = FleetManifestSchema.parse(rawManifest)

export default defineNitroPlugin(() => {
  onOpsEventRecorded(async (db, input) => {
    const config = useRuntimeConfig()
    const env = (globalThis as { __env__?: Record<string, unknown> }).__env__
    const outcome = await notifyIfCritical(db, input, {
      classify: classifyOps,
      mailer: getOpsMailer(env),
      options: {
        appName: config.public.appName,
        appUrl: config.public.appUrl || undefined,
        workerName: manifest.workers[0],
      },
    })
    if (outcome === 'sent' || outcome === 'send-failed') {
      logEvent('warn', 'ops_alert_immediate', { kind: input.kind, outcome })
    }
  })
})
