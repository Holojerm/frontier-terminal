// Cron task: daily closes from Databento after the US close (06:40 UTC, once
// EQUS.SUMMARY has the session), then the Nasdaq hourly backfill for symbols
// that lack it (layers/signals/server/signals/market.ts). Internal data: it
// goes to market_bars and nowhere else.
//
// The key is the Worker secret DATABENTO_API_KEY. Without it the task does
// nothing and says so in its result.

import { db } from '@nuxthub/db'

import { recordOpsEvent } from '#server/utils/ops'
import { pullMarket, type PullReport } from '../../signals/market'
import { withHeartbeat } from '#layers/core/server/utils/task-heartbeat'

export const MARKET_PULL_FAILED_KIND = 'market_pull_failed'

const task = defineTask({
  meta: {
    name: 'signals:prices',
    description: 'Pull daily closes from Databento for the signals harness',
  },
  async run(): Promise<{ result: PullReport | { skipped: string } }> {
    const apiKey = process.env.DATABENTO_API_KEY ?? ''
    if (!apiKey) return { result: { skipped: 'DATABENTO_API_KEY is not set' } }
    const report = await pullMarket(db, {
      apiKey,
      fetch: (input, init) => fetch(input, init),
      now: new Date(),
    })
    if (report.failed.length > 0) {
      await recordOpsEvent(db, {
        kind: MARKET_PULL_FAILED_KIND,
        detail: report.failed.map((f) => `${f.what}: ${f.detail}`).join('; '),
      })
    }
    return { result: report }
  },
})

export default withHeartbeat(task)
