// Cron task: queue the weekly thread, Monday 13:00 UTC beside theses:digest
// (layers/terminal/server/pipeline/social.ts), then schedule a social drain on
// the EVENTS queue (layers/terminal/server/utils/events.ts) to send it. With no
// Buffer key it returns before touching the database.

import { db } from '@nuxthub/db'

import { readSocialConfig } from '#layers/social/server/utils/social'
import { enqueueWeeklyDigest } from '../../pipeline/social'
import { FANOUT_SETTLE_SECONDS } from '../../utils/event-work'
import { kvStore } from '../../utils/event-runtime'
import { scheduleDrain } from '../../utils/events'
import { withHeartbeat } from '../../utils/task-heartbeat'

const task = defineTask({
  meta: {
    name: 'social:digest',
    description: 'Queue the weekly what-moved thread for the social accounts',
  },
  async run() {
    const runtime = useRuntimeConfig()
    const config = readSocialConfig(runtime.social)
    if (!config) return { result: { skipped: 'unconfigured' } }
    const queued = await enqueueWeeklyDigest(db, config.channels, runtime.public.appUrl)
    if (queued) await scheduleDrain(kvStore, 'social.drain', FANOUT_SETTLE_SECONDS, new Date())
    return { result: { queued } }
  },
})

export default withHeartbeat(task)
