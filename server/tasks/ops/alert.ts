// Cron task: mail what the ops spool says needs mailing, then prune it.
// Critical events go out at once, one per kind per cooldown; everything else
// waits for one daily digest (layers/terminal/server/utils/ops-alerts.ts).
//
// Scheduled from nuxt.config.ts (SCHEDULED_TASKS → nitro.scheduledTasks) and
// matched by the [triggers] crons entry in wrangler.toml — both must agree, or
// Cloudflare delivers a cron Nitro has no task for, or Nitro waits for a cron
// that never arrives. `bun run crons:check` fails the build on either.
//
// Silence is the healthy state: outside the digest hour this is one read of
// the pending rows, one DELETE, and a return.
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
import { checkLaunchCoverage } from '#layers/terminal/server/pipeline/launch-watch'
import { unstorageLockStore } from '#layers/terminal/server/pipeline/lock'
import { draftedKey } from '#layers/terminal/server/pipeline/press'
import { checkFreshness } from '#layers/terminal/server/utils/freshness'
import { freshnessChecks } from '#layers/terminal/server/utils/terminal-freshness'
import { getOpsMailer } from '../../utils/ops-mail'
import { pruneOpsEvents } from '../../utils/ops'
import { classifyOps } from '../../utils/ops-severity'
import { logEvent } from '../../utils/log'
import { withHeartbeat } from '#layers/terminal/server/utils/task-heartbeat'
import { runDailyDigest, sendCriticalAlerts } from '#layers/terminal/server/utils/ops-alerts'

interface CloudflareTaskContext {
  cloudflare?: { env?: Record<string, unknown> }
}

const manifest = FleetManifestSchema.parse(rawManifest)

const task = defineTask({
  meta: {
    name: 'ops:alert',
    description: 'Email critical ops events and the daily digest, then prune old ones',
  },
  async run({ context }) {
    // The freshness checks spool their own events, so they run before the
    // mailer check: an unconfigured digest still records that a part went
    // quiet. One per scheduled task, plus the judge routine, the GDELT job and
    // the press-drafts routine (layers/terminal/server/utils/terminal-freshness.ts).
    const config = useRuntimeConfig()
    await checkFreshness(
      db,
      unstorageLockStore(kv),
      freshnessChecks({
        scheduledTasks: config.scheduledTasks,
        drafted: async (id) => Boolean(await kv.getItem(draftedKey(id))),
        pressList: config.pressList,
      }),
    )
    // Same reason: a launch the site has stored but does not show is recorded
    // whether or not the digest can be mailed.
    const launch = await checkLaunchCoverage(db, unstorageLockStore(kv))
    if (launch.stale_cells.length || launch.unalerted.length) {
      logEvent('warn', 'launch_gap', { ...launch })
    }
    // And a merge whose deploy never landed: this build's sha against main's head.
    const head = manifest.links?.github ? await fetchMainHead(manifest.links.github) : null
    const drift = await checkDeployDrift(db, unstorageLockStore(kv), config.public.buildSha, head)
    if (drift.verdict === 'drift') logEvent('warn', 'deploy_drift', { ...drift })

    const env = (context as CloudflareTaskContext | undefined)?.cloudflare?.env
    const mailer = getOpsMailer(env)
    if (!mailer) {
      // Nothing can be sent, but the spool must not grow without bound.
      const pruned = await pruneOpsEvents(db)
      logEvent('warn', 'ops_alert_unconfigured', { pruned })
      return { result: { skipped: 'unconfigured', pruned } }
    }

    const { appName, appUrl } = config.public
    const deps = {
      mailer,
      // Tiers registered by layers and the app from their Nitro plugins
      // (server/utils/ops-severity.ts). Decides what is critical.
      classify: classifyOps,
      options: { appName, appUrl: appUrl || undefined, workerName: manifest.workers[0] },
    }
    const critical = await sendCriticalAlerts(db, deps)
    const daily = await runDailyDigest(db, deps)
    const pruned = await pruneOpsEvents(db)
    const outcome = { critical, daily, pruned }
    // Quiet ticks stay quiet — only say something when something happened.
    if (critical.sent.length || critical.error || daily.sent || daily.error) {
      logEvent('warn', 'ops_alert_run', { ...outcome })
    }
    return { result: outcome }
  },
})

export default withHeartbeat(task)
