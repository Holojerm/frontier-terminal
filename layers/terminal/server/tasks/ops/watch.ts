// Cron task: the watchdogs that spool their own ops events, every 30 minutes.
//
// Split from the digest (server/tasks/ops/alert.ts) so the digest can drain
// every five minutes while these keep their half-hourly cadence: each one
// reads D1 and KV, and the deploy check calls GitHub, which is not worth doing
// six times as often. Whatever they spool goes out with the next drain that
// finds it due (OPS_HOLD_MS in server/utils/ops.ts).
//
// They run whether or not the digest can be mailed, so an unconfigured app
// still records that a part went quiet.
//
// Imports are explicit for the reason server/tasks/ops/alert.ts spells out.

import { db } from '@nuxthub/db'
import { kv } from '@nuxthub/kv'

import { FleetManifestSchema } from '#shared/utils/fleet-manifest'
import { logEvent } from '#server/utils/log'

import rawManifest from '../../../../../fleet.json'
import { fetchMainHead } from '../../pipeline/deploy-watch'
import { checkLaunchCoverage } from '../../pipeline/launch-watch'
import { unstorageLockStore } from '../../pipeline/lock'
import { draftedKey } from '../../pipeline/press'
import { checkFreshness } from '../../utils/freshness'
import { freshnessChecks } from '../../utils/terminal-freshness'
import { withHeartbeat } from '../../utils/task-heartbeat'

const manifest = FleetManifestSchema.parse(rawManifest)

const task = defineTask({
  meta: {
    name: 'ops:watch',
    description: 'Spool an ops event for each part that went quiet or a launch the site hides',
  },
  async run() {
    // One check per scheduled task, plus the judge routine, the GDELT job, the
    // press-drafts routine, and the deploy of main: this build's sha against
    // main's head (layers/terminal/server/utils/terminal-freshness.ts).
    const config = useRuntimeConfig()
    const mainHead = manifest.links?.github ? await fetchMainHead(manifest.links.github) : null
    const freshness = await checkFreshness(
      db,
      unstorageLockStore(kv),
      freshnessChecks({
        scheduledTasks: config.scheduledTasks,
        drafted: async (id) => Boolean(await kv.getItem(draftedKey(id))),
        pressList: config.pressList,
        buildSha: config.public.buildSha,
        mainHead,
      }),
    )
    const launch = await checkLaunchCoverage(db, unstorageLockStore(kv))
    if (launch.stale_cells.length) {
      logEvent('warn', 'launch_gap', { ...launch })
    }
    return { result: { freshness, stale_cells: launch.stale_cells.length } }
  },
})

export default withHeartbeat(task)
