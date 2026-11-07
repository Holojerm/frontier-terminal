// Cron task: the weekly hiring roll-up, Monday 13:00 UTC — one alert per lab
// for the week that ended at midnight (layers/terminal/server/pipeline/hiring-rollup.ts).

import { db } from '@nuxthub/db'

import sourcesYaml from 'raw:~~/sources.yaml'

import { writeHiringRollups } from '../../pipeline/hiring-rollup'
import { parseDepartmentClusters } from '../../utils/terminal-clusters'
import { withHeartbeat } from '../../utils/task-heartbeat'

const task = defineTask({
  meta: {
    name: 'alerts:hiring-rollup',
    description: 'Write one hiring roll-up alert per lab for the last complete week',
  },
  async run() {
    return { result: await writeHiringRollups(db, parseDepartmentClusters(sourcesYaml)) }
  },
})

export default withHeartbeat(task)
