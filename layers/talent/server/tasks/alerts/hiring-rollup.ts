// Cron task: the weekly hiring roll-up, Monday 13:00 UTC — one alert per lab
// for the week that ended at midnight (layers/talent/server/pipeline/hiring-rollup.ts).

import sourcesYaml from 'raw:~~/sources.yaml'

import { writeHiringRollups } from '../../pipeline/hiring-rollup'

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
