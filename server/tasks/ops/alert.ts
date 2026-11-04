// Cron task: drain the ops spool and email a digest.
//
// Scheduled from nuxt.config.ts (SCHEDULED_TASKS → nitro.scheduledTasks) and
// matched by the [triggers] crons entry in wrangler.toml — both must agree, or
// Cloudflare delivers a cron Nitro has no task for, or Nitro waits for a cron
// that never arrives. `bun run crons:check` fails the build on either.
//
// Silence is the healthy state: with nothing spooled this is one indexed
// SELECT, one DELETE, and a return. That is what makes a tight schedule cheap.
//
// Imports are explicit for the reason server/tasks/purge-expired-tokens.ts
// spells out: a task is an untested bundling surface that runs unattended, and
// an auto-import that resolves to `undefined` here would fail every half hour
// with nobody watching.

import { db } from '@nuxthub/db'
import { kv } from '@nuxthub/kv'

import { FleetManifestSchema } from '#shared/utils/fleet-manifest'

import rawManifest from '../../../fleet.json'
import { checkDeployDrift, fetchMainHead } from '#layers/terminal/server/pipeline/deploy-watch'
import { checkJudgeSilence } from '#layers/terminal/server/pipeline/judge/watchdog'
import { checkLaunchCoverage } from '#layers/terminal/server/pipeline/launch-watch'
import { unstorageLockStore } from '#layers/terminal/server/pipeline/lock'
import { getOpsMailer } from '../../utils/ops-mail'
import { drainOpsEvents, pruneOpsEvents } from '../../utils/ops'
import { logEvent } from '../../utils/log'

interface CloudflareTaskContext {
  cloudflare?: { env?: Record<string, unknown> }
}

const manifest = FleetManifestSchema.parse(rawManifest)

export default defineTask({
  meta: {
    name: 'ops:alert',
    description: 'Email a digest of spooled ops events, then prune old ones',
  },
  async run({ context }) {
    // The judge watchdog spools its own event, so it runs before the mailer
    // check: an unconfigured digest still records that the judge went quiet.
    const judge = await checkJudgeSilence(db, unstorageLockStore(kv))
    if (judge === 'silent') logEvent('warn', 'judge_silent')
    // Same reason: a launch the site has stored but does not show is recorded
    // whether or not the digest can be mailed.
    const launch = await checkLaunchCoverage(db, unstorageLockStore(kv))
    if (launch.stale_cells.length || launch.unalerted.length) {
      logEvent('warn', 'launch_gap', { ...launch })
    }
    // And a merge whose deploy never landed: this build's sha against main's head.
    const head = manifest.links?.github ? await fetchMainHead(manifest.links.github) : null
    const drift = await checkDeployDrift(
      db,
      unstorageLockStore(kv),
      useRuntimeConfig().public.buildSha,
      head,
    )
    if (drift.verdict === 'drift') logEvent('warn', 'deploy_drift', { ...drift })

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
    })
    // Quiet ticks stay quiet — only say something when something happened.
    if (outcome.sent || outcome.error) {
      logEvent('warn', 'ops_alert_run', { ...outcome })
    }
    return { result: outcome }
  },
})
