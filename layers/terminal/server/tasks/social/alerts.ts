// Cron task: queue critical alerts for the social accounts
// (layers/terminal/server/pipeline/social.ts). Runs on the */5 tick beside
// the social layer's `social:post`, which sends them. With no Buffer key it
// returns before touching the database.

import { db } from '@nuxthub/db'

import { readSocialConfig } from '#layers/social/server/utils/social'
import { enqueueCriticalAlerts } from '../../pipeline/social'
import { withHeartbeat } from '../../utils/task-heartbeat'

const task = defineTask({
  meta: {
    name: 'social:alerts',
    description: 'Queue critical alerts for the social accounts',
  },
  async run() {
    const runtime = useRuntimeConfig()
    const config = readSocialConfig(runtime.social)
    if (!config) return { result: { skipped: 'unconfigured' } }
    const queued = await enqueueCriticalAlerts(db, config.channels, runtime.public.appUrl)
    if (queued) console.warn(JSON.stringify({ kind: 'social_alerts_queued', queued }))
    return { result: { queued } }
  },
})

export default withHeartbeat(task)
