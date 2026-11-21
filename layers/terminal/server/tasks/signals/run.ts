// Cron task: the signals harness, daily at 07:10 UTC after signals:prices.
// Records and settles the forward calls (signals/forward-rules.ts), then scores
// every registered series against its tickers and replaces signal_results
// (signals/run.ts). A forward-call failure spools an ops event and the
// harness still runs.

import { db } from '@nuxthub/db'
import sourcesYaml from 'raw:~~/sources.yaml'

import { recordOpsEvent } from '#server/utils/ops'
import { KIND_FORWARD_CALLS_FAILED } from '../../signals/forward-calls'
import { runForwardCalls, type ForwardRunReport } from '../../signals/forward-rules'
import { runSignals } from '../../signals/run'
import { queryContext } from '../../utils/terminal-db'
import { queryRevenue } from '../../utils/terminal-revenue'
import { withHeartbeat } from '../../utils/task-heartbeat'

const task = defineTask({
  meta: {
    name: 'signals:run',
    description: 'Score every registered signal against forward market-adjusted returns',
  },
  async run() {
    const now = () => new Date()
    const ctx = queryContext(sourcesYaml, null, now)
    const appUrl = useRuntimeConfig().public.appUrl
    let forward: ForwardRunReport | { failed: string }
    try {
      forward = await runForwardCalls(db, {
        revenue: await queryRevenue(db, ctx),
        now: now(),
        appUrl,
      })
    } catch (error) {
      forward = { failed: String(error) }
      await recordOpsEvent(db, {
        kind: KIND_FORWARD_CALLS_FAILED,
        detail: forward.failed.slice(0, 500),
      })
    }
    const report = await runSignals(db, { ctx, now, id: crypto.randomUUID(), appUrl })
    return { result: { ...report, forward } }
  },
})

export default withHeartbeat(task)
