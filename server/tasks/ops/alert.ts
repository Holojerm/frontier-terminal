// Cron task: drain the ops spool and email a digest, every five minutes.
//
// Scheduled from nuxt.config.ts (SCHEDULED_TASKS → nitro.scheduledTasks) and
// matched by the [triggers] crons entry in wrangler.toml — both must agree, or
// Cloudflare delivers a cron Nitro has no task for, or Nitro waits for a cron
// that never arrives. `bun run crons:check` fails the build on either.
//
// Every five minutes so a critical event waits at most one tick; the per-tier
// holds in drainOpsEvents (OPS_HOLD_MS) keep warnings and info from mailing
// that often. The watchdogs that spool events of their own run half-hourly in
// layers/terminal/server/tasks/ops/watch.ts.
//
// Silence is the healthy state: with nothing spooled this is one indexed
// SELECT, one DELETE, and a return. That is what makes a tight schedule cheap.
//
// Imports are explicit for the reason server/tasks/purge-expired-tokens.ts
// spells out: a task is an untested bundling surface that runs unattended, and
// an auto-import that resolves to `undefined` here would fail every tick with
// nobody watching.

import { db } from '@nuxthub/db'

import { FleetManifestSchema } from '#shared/utils/fleet-manifest'

import rawManifest from '../../../fleet.json'
import { getOpsMailer } from '../../utils/ops-mail'
import { drainOpsEvents, pruneOpsEvents } from '../../utils/ops'
import { classifyOps } from '../../utils/ops-severity'
import { logEvent } from '../../utils/log'
import { withHeartbeat } from '#layers/terminal/server/utils/task-heartbeat'

interface CloudflareTaskContext {
  cloudflare?: { env?: Record<string, unknown> }
}

const manifest = FleetManifestSchema.parse(rawManifest)

const task = defineTask({
  meta: {
    name: 'ops:alert',
    description: 'Email a digest of spooled ops events, then prune old ones',
  },
  async run({ context }) {
    const env = (context as CloudflareTaskContext | undefined)?.cloudflare?.env
    const mailer = getOpsMailer(env)
    if (!mailer) {
      // Nothing can be sent, but the spool must not grow without bound.
      const pruned = await pruneOpsEvents(db)
      logEvent('warn', 'ops_alert_unconfigured', { pruned })
      return { result: { skipped: 'unconfigured', pruned } }
    }

    const { appName, appUrl } = useRuntimeConfig().public
    const outcome = await drainOpsEvents(db, mailer, {
      appName,
      appUrl: appUrl || undefined,
      workerName: manifest.workers[0],
      // Tiers registered by layers and the app from their Nitro plugins
      // (server/utils/ops-severity.ts). Ranks the digest, tags its subject,
      // and sets how long each tier waits.
      classify: classifyOps,
    })
    // Quiet ticks stay quiet — only say something when something happened.
    if (outcome.sent || outcome.error) {
      logEvent('warn', 'ops_alert_run', { ...outcome })
    }
    return { result: outcome }
  },
})

export default withHeartbeat(task)
