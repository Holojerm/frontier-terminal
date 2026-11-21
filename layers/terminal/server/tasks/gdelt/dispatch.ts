// Cron task: start the GDELT Actions job every half hour, because GitHub's
// schedule for it drops most triggers
// (layers/terminal/server/pipeline/track-record/dispatch.ts).

import { db } from '@nuxthub/db'

import manifest from '~~/fleet.json'

import { dispatchGdeltSearch } from '../../pipeline/track-record/dispatch'
import { withHeartbeat } from '../../utils/task-heartbeat'

const task = defineTask({
  meta: {
    name: 'gdelt:dispatch',
    description: 'Start a run of the GDELT search workflow on GitHub Actions',
  },
  async run() {
    const result = await dispatchGdeltSearch(db, {
      fetch: (input, init) => fetch(input, init),
      repoUrl: manifest.links.github ?? '',
      token: useRuntimeConfig().githubDispatchToken,
    })
    return { result }
  },
})

export default withHeartbeat(task)
