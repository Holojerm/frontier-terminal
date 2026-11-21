// Cron task: the signals harness, daily at 07:10 UTC after signals:prices.
// Scores every registered series against its tickers and replaces
// signal_results (layers/terminal/server/signals/run.ts).

import { db } from '@nuxthub/db'
import sourcesYaml from 'raw:~~/sources.yaml'

import { runSignals } from '../../signals/run'
import { queryContext } from '../../utils/terminal-db'
import { withHeartbeat } from '../../utils/task-heartbeat'

const task = defineTask({
  meta: {
    name: 'signals:run',
    description: 'Score every registered signal against forward market-adjusted returns',
  },
  async run() {
    const now = () => new Date()
    const report = await runSignals(db, {
      ctx: queryContext(sourcesYaml, null, now),
      now,
      id: crypto.randomUUID(),
      appUrl: useRuntimeConfig().public.appUrl,
    })
    return { result: report }
  },
})

export default withHeartbeat(task)
