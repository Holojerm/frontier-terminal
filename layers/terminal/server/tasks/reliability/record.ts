// Cron task: the rollup and filing detections behind /data#reliability
// (layers/terminal/server/pipeline/reliability/record.ts). Hourly at :41,
// beside bulk:build. A part that throws is spooled for the ops digest.

import { blob } from '@nuxthub/blob'
import { db } from '@nuxthub/db'

import { recordOpsEvent } from '#server/utils/ops'
import { runReliabilityRecord } from '../../pipeline/reliability/record'
import { withHeartbeat } from '../../utils/task-heartbeat'

const task = defineTask({
  meta: {
    name: 'reliability:record',
    description: 'Roll up source runs by day and record EDGAR acceptance times for rule alerts',
  },
  async run() {
    const report = await runReliabilityRecord(db, {
      raw: {
        get: async (key) => {
          const object = await blob.get(key)
          return object ? await object.text() : null
        },
      },
      now: new Date(),
    })
    for (const [part, result] of Object.entries(report)) {
      if ('error' in result) {
        await recordOpsEvent(db, {
          kind: 'reliability_record_failed',
          detail: `${part}: ${result.error}`,
        })
      }
    }
    return { result: report }
  },
})

export default withHeartbeat(task)
