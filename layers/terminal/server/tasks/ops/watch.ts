// Cron task: run the watchdogs that spool their own ops events, then prune the
// spool, every 30 minutes. This app sends no ops mail: the fleet dashboard reads
// the spool through GET /api/fleet (`ops.kinds`) and is the only alert sender.
//
// Each watchdog reads D1 and KV, and the deploy check calls GitHub, which is not
// worth doing more often. The prune lives here because this app has no purge
// task; without it the spool would grow without bound.
//
// Imports are explicit: a task is an untested bundling surface that runs
// unattended, and an auto-import that resolves to `undefined` here would fail
// every half hour with nobody watching.

import { db } from '@nuxthub/db'
import { kv } from '@nuxthub/kv'

import { FleetManifestSchema } from '#shared/utils/fleet-manifest'
import { logEvent } from '#server/utils/log'
import { pruneOpsEvents } from '#server/utils/ops'

import rawManifest from '../../../../../fleet.json'
import { fetchMainHead } from '../../pipeline/deploy-watch'
import { checkLaunchCoverage } from '../../pipeline/launch-watch'
import { unstorageLockStore } from '../../pipeline/lock'
import { checkFreshness } from '../../utils/freshness'
import { freshnessChecks } from '../../utils/terminal-freshness'
import { withHeartbeat } from '../../utils/task-heartbeat'

const manifest = FleetManifestSchema.parse(rawManifest)

const task = defineTask({
  meta: {
    name: 'ops:watch',
    description:
      'Spool an ops event for each part that went quiet or a launch the site hides, then prune the spool',
  },
  async run() {
    // One check per scheduled task, plus the judge routine, the GDELT job, and
    // the deploy of main: this build's sha against main's head
    // (layers/terminal/server/utils/terminal-freshness.ts).
    const config = useRuntimeConfig()
    const mainHead = manifest.links?.github ? await fetchMainHead(manifest.links.github) : null
    const freshness = await checkFreshness(
      db,
      unstorageLockStore(kv),
      freshnessChecks({
        scheduledTasks: config.scheduledTasks,
        buildSha: config.public.buildSha,
        mainHead,
      }),
    )
    const launch = await checkLaunchCoverage(db, unstorageLockStore(kv))
    if (launch.stale_cells.length) {
      logEvent('warn', 'launch_gap', { ...launch })
    }
    const pruned = await pruneOpsEvents(db)
    return { result: { freshness, stale_cells: launch.stale_cells.length, pruned } }
  },
})

export default withHeartbeat(task)
