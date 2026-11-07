// Cron task: run the freshness and launch-coverage checks, which spool their
// findings into ops_events, then prune the spool. This app sends no mail: the
// fleet dashboard reads the spool through GET /api/fleet (`ops.kinds`) and is
// the only alert sender.
//
// Scheduled from nuxt.config.ts (SCHEDULED_TASKS → nitro.scheduledTasks) and
// matched by the [triggers] crons entry in wrangler.toml — both must agree, or
// Cloudflare delivers a cron Nitro has no task for, or Nitro waits for a cron
// that never arrives. `bun run crons:check` fails the build on either.
//
// Imports are explicit for the reason server/tasks/purge-expired-tokens.ts
// spelled out: a task is an untested bundling surface that runs unattended, and
// an auto-import that resolves to `undefined` here would fail every half hour
// with nobody watching.

import { db } from '@nuxthub/db'
import { kv } from '@nuxthub/kv'

import { FleetManifestSchema } from '#shared/utils/fleet-manifest'

import rawManifest from '../../../fleet.json'
import { fetchMainHead } from '#layers/terminal/server/pipeline/deploy-watch'
import { checkLaunchCoverage } from '#layers/terminal/server/pipeline/launch-watch'
import { unstorageLockStore } from '#layers/terminal/server/pipeline/lock'
import { draftedKey } from '#layers/terminal/server/pipeline/press'
import { checkFreshness } from '#layers/terminal/server/utils/freshness'
import { freshnessChecks } from '#layers/terminal/server/utils/terminal-freshness'
import { pruneOpsEvents } from '../../utils/ops'
import { logEvent } from '../../utils/log'
import { withHeartbeat } from '#layers/terminal/server/utils/task-heartbeat'

const manifest = FleetManifestSchema.parse(rawManifest)

const task = defineTask({
  meta: {
    name: 'ops:watch',
    description:
      'Run the freshness and launch-coverage checks (they spool ops events), then prune the spool',
  },
  async run() {
    // One check per scheduled task, plus the judge routine, the GDELT job, the
    // press-drafts routine, and the deploy of main: this build's sha against
    // main's head (layers/terminal/server/utils/terminal-freshness.ts).
    const config = useRuntimeConfig()
    const mainHead = manifest.links?.github ? await fetchMainHead(manifest.links.github) : null
    await checkFreshness(
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
    // A launch the site has stored but does not show is recorded as an ops event.
    const launch = await checkLaunchCoverage(db, unstorageLockStore(kv))
    if (launch.stale_cells.length) {
      logEvent('warn', 'launch_gap', { ...launch })
    }

    const pruned = await pruneOpsEvents(db)
    return { result: { pruned } }
  },
})

export default withHeartbeat(task)
