// Cron task: the weekly hiring roll-up, Monday 13:00 UTC — one alert per lab
// for the week that ended at midnight (layers/terminal/server/pipeline/hiring-rollup.ts).
// A failure is spooled for the ops digest rather than thrown, so the
// weekly digests sharing this cron still run.

import { db } from '@nuxthub/db'

import sourcesYaml from 'raw:~~/sources.yaml'

import { recordOpsEvent } from '#server/utils/ops'
import { writeHiringRollups } from '../../pipeline/hiring-rollup'
import { parseDepartmentClusters } from '../../utils/terminal-clusters'
import { withHeartbeat } from '../../utils/task-heartbeat'

const task = defineTask({
  meta: {
    name: 'alerts:hiring-rollup',
    description: 'Write one hiring roll-up alert per lab for the last complete week',
  },
  async run() {
    try {
      const result = await writeHiringRollups(db, parseDepartmentClusters(sourcesYaml))
      return { result }
    } catch (error) {
      await recordOpsEvent(db, { kind: 'hiring_rollup_failed', detail: String(error) })
      return { result: { failed: true } }
    }
  },
})

export default withHeartbeat(task)
