// Cron task: the stored records behind /data#reliability
// (layers/terminal/server/pipeline/reliability/record.ts). Hourly at :41,
// beside bulk:build. A part that throws is spooled for the ops digest; a read
// GitHub refuses is expected now and then and only logged.

import { blob } from '@nuxthub/blob'
import { db } from '@nuxthub/db'
import { kv } from '@nuxthub/kv'

import manifest from '~~/fleet.json'

import { recordOpsEvent } from '#server/utils/ops'
import { runReliabilityRecord } from '../../pipeline/reliability/record'

export default defineTask({
  meta: {
    name: 'reliability:record',
    description:
      'Roll up source runs by day, record EDGAR acceptance times for rule alerts, and read the deploy smoke results from GitHub',
  },
  async run() {
    const report = await runReliabilityRecord(db, {
      raw: {
        get: async (key) => {
          const object = await blob.get(key)
          return object ? await object.text() : null
        },
      },
      kv,
      fetch: (input, init) => fetch(input, init),
      repoUrl: manifest.links.github ?? '',
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
    if ('status' in report.deploys && report.deploys.status === 'rate-limited') {
      console.warn(JSON.stringify({ kind: 'github_rate_limited', until: report.deploys.until }))
    }
    return { result: report }
  },
})
